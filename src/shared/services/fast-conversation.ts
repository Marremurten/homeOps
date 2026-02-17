import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { dynamoDBClient as client } from "@shared/utils/dynamodb-client.js";

export async function isConversationFast(
  tableName: string,
  chatId: string,
  senderUserId: number,
  currentTimestamp: number,
): Promise<boolean> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "chatId = :chatId",
      ExpressionAttributeValues: {
        ":chatId": { S: chatId },
      },
      ScanIndexForward: false,
      Limit: 10,
    }),
  );

  const items = result.Items ?? [];
  const cutoff = currentTimestamp - 60;

  const recentOtherCount = items.filter((item) => {
    const userId = Number(item.userId.N);
    const timestamp = Number(item.timestamp.N);
    return userId !== senderUserId && timestamp >= cutoff;
  }).length;

  return recentOtherCount >= 3;
}
