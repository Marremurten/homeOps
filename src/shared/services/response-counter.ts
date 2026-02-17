import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

export async function getResponseCount(
  tableName: string,
  chatId: string,
  date: string,
): Promise<number> {
  const command = new GetItemCommand({
    TableName: tableName,
    Key: {
      chatId: { S: chatId },
      date: { S: date },
    },
  });

  const result = await client.send(command);
  const count = result.Item?.count?.N;
  return count ? Number(count) : 0;
}

export async function incrementResponseCount(
  tableName: string,
  chatId: string,
  date: string,
): Promise<void> {
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  const command = new UpdateItemCommand({
    TableName: tableName,
    Key: {
      chatId: { S: chatId },
      date: { S: date },
    },
    UpdateExpression:
      "SET updatedAt = :now, lastResponseAt = :now, #ttl = :ttl ADD #count :inc",
    ExpressionAttributeNames: {
      "#ttl": "ttl",
      "#count": "count",
    },
    ExpressionAttributeValues: {
      ":now": { S: now },
      ":ttl": { N: String(ttl) },
      ":inc": { N: "1" },
    },
  });

  await client.send(command);
}

export async function getLastResponseAt(
  tableName: string,
  chatId: string,
  date: string,
): Promise<string | null> {
  const command = new GetItemCommand({
    TableName: tableName,
    Key: {
      chatId: { S: chatId },
      date: { S: date },
    },
  });

  const result = await client.send(command);
  return result.Item?.lastResponseAt?.S ?? null;
}
