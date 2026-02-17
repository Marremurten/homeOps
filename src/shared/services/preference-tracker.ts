import {
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { dynamoDBClient as client } from "@shared/utils/dynamodb-client.js";
import { getStockholmDate } from "@shared/utils/stockholm-time.js";

function getAlpha(): number {
  const raw = process.env.EMA_ALPHA_IGNORE;
  return raw ? Number(raw) : 0.2;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ── Ignore Rate ──────────────────────────────────────────────

export async function updateIgnoreRate(
  tableName: string,
  userId: string,
  ignored: boolean,
): Promise<void> {
  const pk = `PREF#${userId}`;
  const sk = "ignoreRate";

  const existing = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk }, sk: { S: sk } },
    }),
  );

  const newValue = ignored ? 1.0 : 0.0;
  const alpha = getAlpha();

  if (existing.Item) {
    const oldRate = Number(existing.Item.rate.N);
    const oldCount = Number(existing.Item.sampleCount.N);
    const rate = round4(alpha * newValue + (1 - alpha) * oldRate);
    const newCount = oldCount + 1;

    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: pk },
          sk: { S: sk },
          rate: { N: String(rate) },
          sampleCount: { N: String(newCount) },
        },
        ConditionExpression: "sampleCount = :expected",
        ExpressionAttributeValues: {
          ":expected": { N: String(oldCount) },
        },
      }),
    );
  } else {
    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: pk },
          sk: { S: sk },
          rate: { N: String(newValue) },
          sampleCount: { N: "1" },
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }
}

export async function getIgnoreRate(
  tableName: string,
  userId: string,
): Promise<{ rate: number; sampleCount: number } | null> {
  const result = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `PREF#${userId}` },
        sk: { S: "ignoreRate" },
      },
    }),
  );

  if (!result.Item) return null;

  return {
    rate: Number(result.Item.rate.N),
    sampleCount: Number(result.Item.sampleCount.N),
  };
}

// ── Interaction Frequency ────────────────────────────────────

export async function updateInteractionFrequency(
  tableName: string,
  userId: string,
  messageCount: number,
): Promise<void> {
  const pk = `PREF#${userId}`;
  const sk = "interactionFrequency";
  const today = getStockholmDate();

  const existing = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk }, sk: { S: sk } },
    }),
  );

  const alpha = getAlpha();

  if (existing.Item) {
    const oldFrequency = Number(existing.Item.frequency.N);
    const oldCount = Number(existing.Item.sampleCount.N);
    const frequency = round4(alpha * messageCount + (1 - alpha) * oldFrequency);
    const newCount = oldCount + 1;

    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: pk },
          sk: { S: sk },
          frequency: { N: String(frequency) },
          sampleCount: { N: String(newCount) },
          lastDate: { S: today },
        },
        ConditionExpression: "sampleCount = :expected",
        ExpressionAttributeValues: {
          ":expected": { N: String(oldCount) },
        },
      }),
    );
  } else {
    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: pk },
          sk: { S: sk },
          frequency: { N: String(messageCount) },
          sampleCount: { N: "1" },
          lastDate: { S: today },
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }
}

export async function getInteractionFrequency(
  tableName: string,
  userId: string,
): Promise<{ frequency: number; sampleCount: number } | null> {
  const result = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `PREF#${userId}` },
        sk: { S: "interactionFrequency" },
      },
    }),
  );

  if (!result.Item) return null;

  return {
    frequency: Number(result.Item.frequency.N),
    sampleCount: Number(result.Item.sampleCount.N),
  };
}
