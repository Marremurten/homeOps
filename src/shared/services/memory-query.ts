import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { dynamoDBClient as client } from "@shared/utils/dynamodb-client.js";

export interface ActivityRecord {
  userId: number;
  userName: string;
  activity: string;
  timestamp: number;
}

function parseItem(item: Record<string, { S?: string; N?: string }>): ActivityRecord {
  return {
    userId: Number(item.userId?.N),
    userName: item.userName?.S ?? "",
    activity: item.activity?.S ?? "",
    timestamp: Number(item.timestamp?.N),
  };
}

export async function queryLastActivity(
  tableName: string,
  chatId: string,
  activity: string,
): Promise<ActivityRecord | null> {
  const command = new QueryCommand({
    TableName: tableName,
    IndexName: "chatId-activity-index",
    KeyConditionExpression: "chatId = :chatId AND begins_with(activityTimestamp, :activityPrefix)",
    ExpressionAttributeValues: {
      ":chatId": { S: chatId },
      ":activityPrefix": { S: `${activity}#` },
    },
    ScanIndexForward: false,
    Limit: 1,
  });

  const result = await client.send(command);

  if (!result.Items || result.Items.length === 0) {
    return null;
  }

  return parseItem(result.Items[0] as Record<string, { S?: string; N?: string }>);
}

export async function queryUserActivity(
  tableName: string,
  userId: number,
  activity: string,
  sinceTimestamp: number,
): Promise<ActivityRecord[]> {
  const command = new QueryCommand({
    TableName: tableName,
    IndexName: "userId-timestamp-index",
    KeyConditionExpression: "userId = :userId AND #ts >= :sinceTimestamp",
    FilterExpression: "activity = :activity",
    ExpressionAttributeNames: {
      "#ts": "timestamp",
    },
    ExpressionAttributeValues: {
      ":userId": { N: String(userId) },
      ":sinceTimestamp": { N: String(sinceTimestamp) },
      ":activity": { S: activity },
    },
  });

  const result = await client.send(command);

  if (!result.Items) {
    return [];
  }

  return result.Items.map((item) => parseItem(item as Record<string, { S?: string; N?: string }>));
}

export async function queryActivityCount(
  tableName: string,
  userId: number,
  activity: string,
  sinceTimestamp: number,
): Promise<number> {
  const command = new QueryCommand({
    TableName: tableName,
    IndexName: "userId-timestamp-index",
    KeyConditionExpression: "userId = :userId AND #ts >= :sinceTimestamp",
    FilterExpression: "activity = :activity",
    ExpressionAttributeNames: {
      "#ts": "timestamp",
    },
    ExpressionAttributeValues: {
      ":userId": { N: String(userId) },
      ":sinceTimestamp": { N: String(sinceTimestamp) },
      ":activity": { S: activity },
    },
    Select: "COUNT",
  });

  const result = await client.send(command);

  return result.Count ?? 0;
}
