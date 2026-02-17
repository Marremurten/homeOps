import {
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { MessageBody } from "@shared/types/classification.js";
import { classifyMessage } from "@shared/services/classifier.js";
import { saveActivity } from "@shared/services/activity-store.js";
import { evaluateResponsePolicy } from "@shared/services/response-policy.js";
import { sendMessage, getBotInfo } from "@shared/services/telegram-sender.js";
import { incrementResponseCount } from "@shared/services/response-counter.js";
import { getStockholmDate } from "@shared/utils/stockholm-time.js";
import { getSecret } from "@shared/utils/secrets.js";
import { dynamoDBClient as client } from "@shared/utils/dynamodb-client.js";
import { requireEnv } from "@shared/utils/require-env.js";
import { resolveAliases } from "@shared/services/alias-resolver.js";
import { getEffortEma, updateEffortEma } from "@shared/services/effort-tracker.js";
import { updatePatternHabit } from "@shared/services/pattern-tracker.js";
import { updateInteractionFrequency } from "@shared/services/preference-tracker.js";
import { setDmOptedIn } from "@shared/services/dm-status.js";
import { handleClarificationReply } from "@shared/services/clarification-handler.js";

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const body: MessageBody = JSON.parse(record.body);
    const createdAt = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

    const command = new PutItemCommand({
      TableName: requireEnv("MESSAGES_TABLE_NAME"),
      ConditionExpression:
        "attribute_not_exists(chatId) AND attribute_not_exists(messageId)",
      Item: {
        chatId: { S: String(body.chatId) },
        messageId: { N: String(body.messageId) },
        userId: { N: String(body.userId) },
        userName: { S: body.userName },
        text: { S: body.text },
        timestamp: { N: String(body.timestamp) },
        raw: { S: record.body },
        createdAt: { S: createdAt },
        ttl: { N: String(ttl) },
      },
    });

    try {
      await client.send(command);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        // Idempotent: item already exists, treat as success
      } else {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }
    }

    // --- Private chat routing ---
    if (body.chatType === "private") {
      if (body.text === "/start") {
        try {
          const homeopsTableName = requireEnv("HOMEOPS_TABLE_NAME");
          await setDmOptedIn(homeopsTableName, String(body.userId), Number(body.chatId));
          const token = await getSecret(requireEnv("TELEGRAM_BOT_TOKEN_ARN"));
          await sendMessage({
            token,
            chatId: Number(body.chatId),
            text: "Welcome! You have opted in to direct messages.",
          });
        } catch (err) {
          console.error("Private /start handling failed:", err);
        }
      } else {
        console.log("Private non-/start message, skipping");
      }
      continue;
    }

    // --- Clarification response ---
    if (body.replyToIsBot && body.replyToText) {
      try {
        const homeopsTableName = requireEnv("HOMEOPS_TABLE_NAME");
        const apiKey = await getSecret(requireEnv("OPENAI_API_KEY_ARN"));
        const result = await handleClarificationReply({
          tableName: homeopsTableName,
          chatId: String(body.chatId),
          userId: String(body.userId),
          replyToText: body.replyToText,
          userReplyText: body.text,
          apiKey,
        });
        if (result.handled) {
          continue;
        }
      } catch (err) {
        console.error("Clarification handling failed:", err);
      }
    }

    // --- Classification pipeline ---

    const homeopsTableName = requireEnv("HOMEOPS_TABLE_NAME");

    // Step 1: Resolve aliases
    let textForClassifier = body.text;
    let appliedAliases: Array<{ alias: string; canonicalActivity: string }> = [];
    try {
      const aliasResult = await resolveAliases(homeopsTableName, String(body.chatId), body.text);
      appliedAliases = aliasResult.appliedAliases;
      if (appliedAliases.length > 0) {
        textForClassifier = aliasResult.resolvedText;
      }
    } catch (err) {
      console.error("resolveAliases failed:", err);
    }

    // Step 2: Get effort context
    let effortEma: { activity: string; ema: number } | undefined;
    try {
      const firstAlias = appliedAliases[0];
      if (firstAlias) {
        const record = await getEffortEma(homeopsTableName, String(body.userId), firstAlias.canonicalActivity);
        if (record) {
          effortEma = { activity: firstAlias.canonicalActivity, ema: record.ema };
        }
      }
    } catch (err) {
      console.error("getEffortEma failed:", err);
    }

    // Step 3: Classify
    let classification;
    try {
      const apiKey = await getSecret(requireEnv("OPENAI_API_KEY_ARN"));
      classification = await classifyMessage(textForClassifier, apiKey, {
        aliases: appliedAliases,
        effortEma,
      });
    } catch (err) {
      console.error("Classification failed:", err);
      continue;
    }

    console.log("Classification result:", JSON.stringify(classification));

    // Step 4: Skip if type is "none"
    if (classification.type === "none") {
      continue;
    }

    // Step 5: Store activity
    let activityId: string | undefined;
    try {
      activityId = await saveActivity({
        tableName: requireEnv("ACTIVITIES_TABLE_NAME"),
        chatId: body.chatId,
        messageId: body.messageId,
        userId: body.userId,
        userName: body.userName,
        classification,
        timestamp: body.timestamp,
      });
    } catch (err) {
      console.error("saveActivity failed:", err);
      continue;
    }

    // Step 6: Update trackers
    try {
      await updateEffortEma(homeopsTableName, String(body.userId), classification.activity, classification.effort);
    } catch (err) {
      console.error("updateEffortEma failed:", err);
    }

    try {
      await updatePatternHabit(homeopsTableName, String(body.chatId), String(body.userId), classification.activity, body.timestamp * 1000);
    } catch (err) {
      console.error("updatePatternHabit failed:", err);
    }

    try {
      await updateInteractionFrequency(homeopsTableName, String(body.userId), 1);
    } catch (err) {
      console.error("updateInteractionFrequency failed:", err);
    }

    // Step 7: Evaluate response policy
    let policyResult;
    try {
      const token = await getSecret(requireEnv("TELEGRAM_BOT_TOKEN_ARN"));
      const botInfo = await getBotInfo(token);
      policyResult = await evaluateResponsePolicy({
        classification,
        chatId: body.chatId,
        senderUserId: body.userId,
        currentTimestamp: body.timestamp,
        messagesTableName: requireEnv("MESSAGES_TABLE_NAME"),
        countersTableName: requireEnv("RESPONSE_COUNTERS_TABLE_NAME"),
        botUsername: botInfo.username,
        messageText: body.text,
        homeopsTableName,
        userId: body.userId,
      });
    } catch (err) {
      console.error("evaluateResponsePolicy failed:", err);
      continue;
    }

    console.log("Policy result:", JSON.stringify(policyResult));

    // Step 8: Respond if policy says so
    if (policyResult.respond && policyResult.text) {
      try {
        const token = await getSecret(requireEnv("TELEGRAM_BOT_TOKEN_ARN"));
        const result = await sendMessage({
          token,
          chatId: Number(body.chatId),
          text: policyResult.text,
          replyToMessageId: body.messageId,
        });

        if (result.ok) {
          const stockholmDate = getStockholmDate(
            new Date(body.timestamp * 1000),
          );
          await incrementResponseCount(
            requireEnv("RESPONSE_COUNTERS_TABLE_NAME"),
            body.chatId,
            stockholmDate,
          );

          // Update activity with bot message ID
          if (activityId && result.messageId) {
            try {
              await client.send(
                new UpdateItemCommand({
                  TableName: requireEnv("ACTIVITIES_TABLE_NAME"),
                  Key: {
                    chatId: { S: body.chatId },
                    activityId: { S: activityId },
                  },
                  UpdateExpression: "SET botMessageId = :mid",
                  ExpressionAttributeValues: {
                    ":mid": { N: String(result.messageId) },
                  },
                }),
              );
            } catch (err) {
              console.error("botMessageId update failed:", err);
            }
          }
        }
      } catch (err) {
        console.error("Telegram send/increment failed:", err);
      }
    }
  }

  return { batchItemFailures };
}
