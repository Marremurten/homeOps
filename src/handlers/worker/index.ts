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

    // --- Classification pipeline ---

    // Step 1: Classify
    let classification;
    try {
      const apiKey = await getSecret(requireEnv("OPENAI_API_KEY_ARN"));
      classification = await classifyMessage(body.text, apiKey);
    } catch (err) {
      console.error("Classification failed:", err);
      continue;
    }

    console.log("Classification result:", JSON.stringify(classification));

    // Step 2: Skip if type is "none"
    if (classification.type === "none") {
      continue;
    }

    // Step 3: Store activity
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

    // Step 4: Evaluate response policy
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
      });
    } catch (err) {
      console.error("evaluateResponsePolicy failed:", err);
      continue;
    }

    console.log("Policy result:", JSON.stringify(policyResult));

    // Step 5: Respond if policy says so
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
