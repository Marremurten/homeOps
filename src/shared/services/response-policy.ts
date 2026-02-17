import type { ClassificationResult } from "@shared/types/classification.js";
import { isQuietHours, getStockholmDate } from "@shared/utils/stockholm-time.js";
import { getResponseCount, getLastResponseAt } from "@shared/services/response-counter.js";
import { isConversationFast } from "@shared/services/fast-conversation.js";
import { validateTone } from "@shared/utils/tone-validator.js";
import { getIgnoreRate, getInteractionFrequency } from "@shared/services/preference-tracker.js";

export const CONFIDENCE_HIGH = 0.85;
export const CONFIDENCE_CLARIFY = 0.50;
export const DAILY_CAP = 3;
export const COOLDOWN_MINUTES = 15;
export const IGNORE_RATE_THRESHOLD = 0.7;
export const LOW_FREQUENCY_THRESHOLD = 1.0;
export const MIN_DATA_POINTS = 10;

interface PolicyParams {
  classification: ClassificationResult;
  chatId: string;
  senderUserId: number;
  currentTimestamp: number;
  messagesTableName: string;
  countersTableName: string;
  botUsername?: string;
  messageText?: string;
  homeopsTableName?: string;
  userId?: number;
}

interface PolicyResult {
  respond: boolean;
  text?: string;
  reason?: string;
}

export async function evaluateResponsePolicy(params: PolicyParams): Promise<PolicyResult> {
  const {
    classification,
    chatId,
    senderUserId,
    currentTimestamp,
    messagesTableName,
    countersTableName,
    botUsername,
    messageText,
    homeopsTableName,
    userId,
  } = params;

  // 1. type === "none" -> early exit, no other checks
  if (classification.type === "none") {
    return { respond: false, reason: "none" };
  }

  // 2. Quiet hours
  if (isQuietHours(new Date(currentTimestamp * 1000))) {
    return { respond: false, reason: "quiet_hours" };
  }

  // Compute date for counter lookups
  const date = getStockholmDate(new Date(currentTimestamp * 1000));

  // 3. Daily cap
  const count = await getResponseCount(countersTableName, chatId, date);
  if (count >= DAILY_CAP) {
    return { respond: false, reason: "daily_cap" };
  }

  // 4. Fast conversation
  const fast = await isConversationFast(messagesTableName, chatId, senderUserId, currentTimestamp);
  if (fast) {
    return { respond: false, reason: "fast_conversation" };
  }

  // 5. Cooldown
  const lastResponseAt = await getLastResponseAt(countersTableName, chatId, date);
  if (lastResponseAt !== null) {
    const lastResponseTimestamp = new Date(lastResponseAt).getTime() / 1000;
    const minutesSinceLast = (currentTimestamp - lastResponseTimestamp) / 60;
    if (minutesSinceLast < COOLDOWN_MINUTES) {
      return { respond: false, reason: "cooldown" };
    }
  }

  // Check if directly addressed
  const directlyAddressed =
    botUsername !== undefined &&
    messageText !== undefined &&
    messageText.includes(`@${botUsername}`);

  // 6. Determine response text based on confidence
  let text: string;
  let isAcknowledgment = false;
  let isClarification = false;
  if (classification.confidence >= CONFIDENCE_HIGH) {
    text = "Noterat \u2713";
    isAcknowledgment = true;
  } else if (classification.confidence >= CONFIDENCE_CLARIFY) {
    text = `Menade du ${classification.activity}?`;
    isClarification = true;
  } else if (directlyAddressed) {
    text = `Menade du ${classification.activity}?`;
    isClarification = true;
  } else {
    return { respond: false, reason: "low_confidence" };
  }

  // 7. Preference-aware suppression
  if (homeopsTableName !== undefined && userId !== undefined) {
    const userIdStr = String(userId);

    if (isAcknowledgment) {
      const ignoreData = await getIgnoreRate(homeopsTableName, userIdStr);
      if (
        ignoreData !== null &&
        ignoreData.rate > IGNORE_RATE_THRESHOLD &&
        ignoreData.sampleCount >= MIN_DATA_POINTS
      ) {
        return { respond: false, reason: "preference_suppressed" };
      }
    }

    if (isClarification) {
      const freqData = await getInteractionFrequency(homeopsTableName, userIdStr);
      if (
        freqData !== null &&
        freqData.frequency < LOW_FREQUENCY_THRESHOLD &&
        freqData.sampleCount >= MIN_DATA_POINTS
      ) {
        return { respond: false, reason: "low_frequency_suppressed" };
      }
    }
  }

  // 10. Tone validation
  const toneResult = validateTone(text);
  if (!toneResult.valid) {
    return { respond: false, reason: "tone" };
  }

  return { respond: true, text };
}
