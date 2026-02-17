import {
  QueryCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { dynamoDBClient as client } from "@shared/utils/dynamodb-client.js";

export interface AliasRecord {
  alias: string;
  canonicalActivity: string;
  confirmations: number;
  source: string;
}

export async function getAliasesForChat(
  tableName: string,
  chatId: string,
): Promise<AliasRecord[]> {
  const command = new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: {
      ":pk": { S: `ALIAS#${chatId}` },
    },
  });

  const result = await client.send(command);
  const items = result.Items ?? [];

  return items.map((item) => ({
    alias: item.SK?.S ?? "",
    canonicalActivity: item.canonicalActivity?.S ?? "",
    confirmations: Number(item.confirmations?.N ?? "0"),
    source: item.source?.S ?? "",
  }));
}

export interface PutAliasParams {
  tableName: string;
  chatId: string;
  alias: string;
  canonicalActivity: string;
  source: "seed" | "learned";
}

export async function putAlias(params: PutAliasParams): Promise<void> {
  const command = new PutItemCommand({
    TableName: params.tableName,
    Item: {
      PK: { S: `ALIAS#${params.chatId}` },
      SK: { S: params.alias },
      canonicalActivity: { S: params.canonicalActivity },
      source: { S: params.source },
      confirmations: { N: "0" },
      GSI1PK: { S: `ALIAS#${params.canonicalActivity}` },
      GSI1SK: { S: `${params.chatId}#${params.alias}` },
    },
  });

  await client.send(command);
}

export async function incrementConfirmation(
  tableName: string,
  chatId: string,
  alias: string,
): Promise<void> {
  const command = new UpdateItemCommand({
    TableName: tableName,
    Key: {
      PK: { S: `ALIAS#${chatId}` },
      SK: { S: alias },
    },
    UpdateExpression: "ADD confirmations :inc",
    ExpressionAttributeValues: {
      ":inc": { N: "1" },
    },
  });

  await client.send(command);
}

export async function deleteAlias(
  tableName: string,
  chatId: string,
  alias: string,
): Promise<void> {
  const command = new DeleteItemCommand({
    TableName: tableName,
    Key: {
      PK: { S: `ALIAS#${chatId}` },
      SK: { S: alias },
    },
  });

  await client.send(command);
}
