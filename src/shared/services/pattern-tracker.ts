import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { dynamoDBClient as client } from "@shared/utils/dynamodb-client.js";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const HOUR_KEYS = Array.from({ length: 24 }, (_, i) => String(i));

type DynS = { S: string };
type DynN = { N: string };

function getStockholmDayAndHour(timestampMs: number): { dayKey: string; hour: string } {
  const date = new Date(timestampMs);

  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Stockholm",
    weekday: "short",
  });
  const dayShort = dayFormatter.format(date).toLowerCase();
  const dayKey = DAY_KEYS.find((d) => dayShort.startsWith(d))!;

  const hourFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Stockholm",
    hour: "numeric",
    hour12: false,
  });
  const hour = String(Number(hourFormatter.format(date)));

  return { dayKey, hour };
}

function makeEmptyItem(
  pk: string,
  sk: string,
): Record<string, DynS | DynN> {
  const item: Record<string, DynS | DynN> = {
    pk: { S: pk },
    sk: { S: sk },
    totalCount: { N: "0" },
    lastSeen: { S: "" },
  };

  for (const day of DAY_KEYS) {
    item[day] = { N: "0" };
  }

  for (const h of HOUR_KEYS) {
    item[h] = { N: "0" };
  }

  return item;
}

export async function getPatternHabit(
  tableName: string,
  chatId: string,
  userId: string,
  activity: string,
): Promise<Record<string, DynS | DynN> | null> {
  const pk = `PATTERN#${chatId}#${userId}`;
  const command = new GetItemCommand({
    TableName: tableName,
    Key: {
      pk: { S: pk },
      sk: { S: activity },
    },
  });

  const result = await client.send(command);

  if (!result.Item) {
    return null;
  }

  return result.Item as Record<string, DynS | DynN>;
}

export async function updatePatternHabit(
  tableName: string,
  chatId: string,
  userId: string,
  activity: string,
  timestampMs: number,
): Promise<void> {
  const pk = `PATTERN#${chatId}#${userId}`;
  const existing = await getPatternHabit(tableName, chatId, userId, activity);

  const item = existing ?? makeEmptyItem(pk, activity);

  const { dayKey, hour } = getStockholmDayAndHour(timestampMs);

  // Increment day counter
  const currentDay = Number((item[dayKey] as DynN).N);
  item[dayKey] = { N: String(currentDay + 1) };

  // Increment hour counter
  const currentHour = Number((item[hour] as DynN).N);
  item[hour] = { N: String(currentHour + 1) };

  // Increment totalCount
  const currentTotal = Number((item.totalCount as DynN).N);
  item.totalCount = { N: String(currentTotal + 1) };

  // Update lastSeen
  item.lastSeen = { S: new Date(timestampMs).toISOString() };

  const putCommand = new PutItemCommand({
    TableName: tableName,
    Item: item,
  });

  await client.send(putCommand);
}
