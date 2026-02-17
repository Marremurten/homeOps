import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { dynamoDBClient as client } from "@shared/utils/dynamodb-client.js";

export interface DmStatus {
  optedIn: boolean;
  privateChatId?: number;
}

export async function getDmStatus(
  tableName: string,
  userId: string,
): Promise<DmStatus | null> {
  const command = new GetItemCommand({
    TableName: tableName,
    Key: {
      pk: { S: `DM#${userId}` },
      sk: { S: "STATUS" },
    },
  });

  const result = await client.send(command);

  if (!result.Item) {
    return null;
  }

  const status: DmStatus = {
    optedIn: result.Item.optedIn?.BOOL ?? false,
  };

  if (result.Item.privateChatId?.N !== undefined) {
    status.privateChatId = Number(result.Item.privateChatId.N);
  }

  return status;
}

export async function setDmOptedIn(
  tableName: string,
  userId: string,
  privateChatId: number,
): Promise<void> {
  const command = new PutItemCommand({
    TableName: tableName,
    Item: {
      pk: { S: `DM#${userId}` },
      sk: { S: "STATUS" },
      optedIn: { BOOL: true },
      privateChatId: { N: String(privateChatId) },
      optedInAt: { S: new Date().toISOString() },
      updatedAt: { S: new Date().toISOString() },
    },
  });

  await client.send(command);
}

export async function markPrompted(
  tableName: string,
  userId: string,
): Promise<void> {
  const command = new UpdateItemCommand({
    TableName: tableName,
    Key: {
      pk: { S: `DM#${userId}` },
      sk: { S: "STATUS" },
    },
    UpdateExpression: "SET prompted = :prompted",
    ExpressionAttributeValues: {
      ":prompted": { BOOL: true },
    },
  });

  await client.send(command);
}
