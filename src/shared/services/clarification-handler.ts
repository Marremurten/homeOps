import {
  AFFIRMATIVE_PATTERNS,
  extractNegationRemainder,
} from "@shared/data/swedish-patterns.js";
import {
  putAlias,
  incrementConfirmation,
  getAliasesForChat,
} from "@shared/services/alias-store.js";
import { classifyMessage } from "@shared/services/classifier.js";

const CLARIFICATION_REGEX = /Menade du (.+)\?/;
const CONFIDENCE_THRESHOLD = 0.7;

export type ClarificationResult =
  | { handled: true; action: "confirmed" | "corrected"; activity: string }
  | { handled: false; reason: "not_clarification" | "ambiguous" | "low_confidence" };

export async function handleClarificationReply(params: {
  tableName: string;
  chatId: string;
  userId: string;
  replyToText: string;
  userReplyText: string;
  apiKey: string;
}): Promise<ClarificationResult> {
  const { tableName, chatId, userId, replyToText, userReplyText, apiKey } = params;

  // Extract suggested activity from bot message
  const match = replyToText.match(CLARIFICATION_REGEX);
  if (!match) {
    return { handled: false, reason: "not_clarification" };
  }
  const suggestedActivity = match[1];

  // Check for affirmative reply
  if (AFFIRMATIVE_PATTERNS.test(userReplyText.trim())) {
    const existingAliases = await getAliasesForChat(tableName, chatId);
    const existing = existingAliases.find(
      (a) => a.canonicalActivity === suggestedActivity,
    );

    if (existing) {
      await incrementConfirmation(tableName, chatId, existing.alias);
    } else {
      await putAlias({
        tableName,
        chatId,
        alias: suggestedActivity,
        canonicalActivity: suggestedActivity,
        source: "learned",
      });
    }

    return { handled: true, action: "confirmed", activity: suggestedActivity };
  }

  // Check for negation with correction
  const remainder = extractNegationRemainder(userReplyText.trim());
  if (remainder) {
    const aliases = await getAliasesForChat(tableName, chatId);
    const classification = await classifyMessage(remainder, apiKey, {
      aliases: aliases.map((a) => ({
        alias: a.alias,
        canonicalActivity: a.canonicalActivity,
      })),
    });

    if (classification.confidence >= CONFIDENCE_THRESHOLD) {
      await putAlias({
        tableName,
        chatId,
        alias: classification.activity,
        canonicalActivity: classification.activity,
        source: "learned",
      });

      return { handled: true, action: "corrected", activity: classification.activity };
    }

    return { handled: false, reason: "low_confidence" };
  }

  // Neither affirmative nor negation
  return { handled: false, reason: "ambiguous" };
}
