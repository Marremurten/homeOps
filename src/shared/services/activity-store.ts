import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { ulid } from "ulidx";
import type { ClassificationResult } from "@shared/types/classification.js";
import { dynamoDBClient as client } from "@shared/utils/dynamodb-client.js";

export interface SaveActivityParams {
  tableName: string;
  chatId: string;
  messageId: number;
  userId: number;
  userName: string;
  classification: ClassificationResult;
  timestamp: number;
  botMessageId?: number;
}

export async function saveActivity(params: SaveActivityParams): Promise<string> {
  const activityId = ulid(params.timestamp);

  const item: Record<string, { S: string } | { N: string }> = {
    chatId: { S: params.chatId },
    activityId: { S: activityId },
    messageId: { N: String(params.messageId) },
    userId: { N: String(params.userId) },
    userName: { S: params.userName },
    type: { S: params.classification.type },
    activity: { S: params.classification.activity },
    effort: { S: params.classification.effort },
    confidence: { N: String(params.classification.confidence) },
    timestamp: { N: String(params.timestamp) },
    createdAt: { S: new Date().toISOString() },
    activityTimestamp: { S: `${params.classification.activity}#${params.timestamp}` },
  };

  if (params.botMessageId !== undefined) {
    item.botMessageId = { N: String(params.botMessageId) };
  }

  const command = new PutItemCommand({
    TableName: params.tableName,
    Item: item,
  });

  await client.send(command);

  return activityId;
}
