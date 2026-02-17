import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { SQSEvent } from "aws-lambda";

const client = new DynamoDBClient({});

interface MessageBody {
  chatId: string;
  messageId: number;
  userId: number;
  userName: string;
  text: string;
  timestamp: number;
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const body: MessageBody = JSON.parse(record.body);
    const createdAt = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

    const command = new PutItemCommand({
      TableName: process.env.MESSAGES_TABLE_NAME,
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
        continue;
      }
      throw error;
    }
  }
}
