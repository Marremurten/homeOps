import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { dynamoDBClient as client } from "@shared/utils/dynamodb-client.js";

export const EFFORT_VALUES: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export interface EffortEmaRecord {
  ema: number;
  sampleCount: number;
}

export async function getEffortEma(
  tableName: string,
  userId: string,
  activity: string,
): Promise<EffortEmaRecord | null> {
  const command = new GetItemCommand({
    TableName: tableName,
    Key: {
      pk: { S: `EFFORT#${userId}` },
      sk: { S: activity },
    },
  });

  const result = await client.send(command);

  if (!result.Item) {
    return null;
  }

  return {
    ema: Number(result.Item.ema.N),
    sampleCount: Number(result.Item.sampleCount.N),
  };
}

export async function updateEffortEma(
  tableName: string,
  userId: string,
  activity: string,
  effort: string,
): Promise<void> {
  const alpha = Number(process.env.EMA_ALPHA ?? "0.3");
  const effortValue = EFFORT_VALUES[effort];

  const current = await getEffortEma(tableName, userId, activity);

  let newEma: number;
  let newSampleCount: number;
  let conditionExpression: string;
  let expressionAttributeValues: Record<string, { N: string }> | undefined;

  if (current === null) {
    newEma = effortValue;
    newSampleCount = 1;
    conditionExpression = "attribute_not_exists(pk)";
  } else {
    newEma = Math.round((alpha * effortValue + (1 - alpha) * current.ema) * 10000) / 10000;
    newSampleCount = current.sampleCount + 1;
    conditionExpression = "sampleCount = :expected";
    expressionAttributeValues = {
      ":expected": { N: String(current.sampleCount) },
    };
  }

  const putCommand = new PutItemCommand({
    TableName: tableName,
    Item: {
      pk: { S: `EFFORT#${userId}` },
      sk: { S: activity },
      ema: { N: String(newEma) },
      sampleCount: { N: String(newSampleCount) },
    },
    ConditionExpression: conditionExpression,
    ...(expressionAttributeValues && { ExpressionAttributeValues: expressionAttributeValues }),
  });

  try {
    await client.send(putCommand);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      console.warn(`Optimistic lock failed for EFFORT#${userId}/${activity}, skipping update`);
      return;
    }
    throw error;
  }
}
