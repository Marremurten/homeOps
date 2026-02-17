import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  QueryCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "QueryCommand", input };
  }),
}));

vi.mock("@shared/utils/dynamodb-client.js", () => ({
  dynamoDBClient: { send: mockSend },
}));

const TABLE_NAME = "HomeOps-Activities";
const CHAT_ID = "-100123456";
const USER_ID = 7890;
const ACTIVITY = "dishes";
const SINCE_TIMESTAMP = 1700000000;

describe("memory-query service", () => {
  let queryLastActivity: typeof import("@shared/services/memory-query.js").queryLastActivity;
  let queryUserActivity: typeof import("@shared/services/memory-query.js").queryUserActivity;
  let queryActivityCount: typeof import("@shared/services/memory-query.js").queryActivityCount;
  let QueryCommand: typeof import("@aws-sdk/client-dynamodb").QueryCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@shared/services/memory-query.js");
    queryLastActivity = mod.queryLastActivity;
    queryUserActivity = mod.queryUserActivity;
    queryActivityCount = mod.queryActivityCount;

    const dynamodb = await import("@aws-sdk/client-dynamodb");
    QueryCommand = dynamodb.QueryCommand;
  });

  describe("queryLastActivity", () => {
    it("sends a QueryCommand with the correct table name", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY);

      expect(QueryCommand).toHaveBeenCalledOnce();
      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.TableName).toBe(TABLE_NAME);
    });

    it("queries the chatId-activity-index GSI", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.IndexName).toBe("chatId-activity-index");
    });

    it("uses chatId as the partition key condition", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      const exprValues = queryInput.ExpressionAttributeValues as Record<string, { S?: string }>;

      // Should have chatId value in expression attributes
      const chatIdValue = Object.values(exprValues).find((v) => v.S === CHAT_ID);
      expect(chatIdValue).toBeDefined();
    });

    it("uses begins_with on the sort key for the activity prefix", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      const keyCondition = queryInput.KeyConditionExpression as string;

      expect(keyCondition).toContain("begins_with");

      // The begins_with value should start with the activity name followed by #
      const exprValues = queryInput.ExpressionAttributeValues as Record<string, { S?: string }>;
      const activityPrefix = Object.values(exprValues).find(
        (v) => v.S?.startsWith(`${ACTIVITY}#`),
      );
      expect(activityPrefix).toBeDefined();
    });

    it("queries in reverse order (ScanIndexForward: false) to get the latest", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.ScanIndexForward).toBe(false);
    });

    it("limits results to 1 item", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.Limit).toBe(1);
    });

    it("returns the activity record when an item is found", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            userId: { N: "7890" },
            userName: { S: "alice" },
            activity: { S: "dishes" },
            timestamp: { N: "1700000000" },
          },
        ],
      });

      const result = await queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY);

      expect(result).toEqual({
        userId: 7890,
        userName: "alice",
        activity: "dishes",
        timestamp: 1700000000,
      });
    });

    it("returns null when no items are found", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      const result = await queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY);

      expect(result).toBeNull();
    });

    it("returns null when Items is undefined", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY);

      expect(result).toBeNull();
    });

    it("calls send exactly once per invocation", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY);

      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ResourceNotFoundException"));

      await expect(queryLastActivity(TABLE_NAME, CHAT_ID, ACTIVITY)).rejects.toThrow(
        "ResourceNotFoundException",
      );
    });
  });

  describe("queryUserActivity", () => {
    it("sends a QueryCommand with the correct table name", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryUserActivity(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      expect(QueryCommand).toHaveBeenCalledOnce();
      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.TableName).toBe(TABLE_NAME);
    });

    it("queries the userId-timestamp-index GSI", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryUserActivity(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.IndexName).toBe("userId-timestamp-index");
    });

    it("uses userId as the partition key condition", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryUserActivity(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      const exprValues = queryInput.ExpressionAttributeValues as Record<string, { N?: string; S?: string }>;

      // Should have userId as a number value in expression attributes
      const userIdValue = Object.values(exprValues).find((v) => v.N === String(USER_ID));
      expect(userIdValue).toBeDefined();
    });

    it("uses >= sinceTimestamp as the sort key condition", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryUserActivity(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      const keyCondition = queryInput.KeyConditionExpression as string;

      // Should have a >= condition on the timestamp sort key
      expect(keyCondition).toMatch(/>=/);

      const exprValues = queryInput.ExpressionAttributeValues as Record<string, { N?: string }>;
      const timestampValue = Object.values(exprValues).find(
        (v) => v.N === String(SINCE_TIMESTAMP),
      );
      expect(timestampValue).toBeDefined();
    });

    it("includes a FilterExpression for the activity name", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryUserActivity(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.FilterExpression).toBeDefined();

      const filterExpr = queryInput.FilterExpression as string;
      expect(filterExpr).toContain("activity");

      const exprValues = queryInput.ExpressionAttributeValues as Record<string, { S?: string }>;
      const activityValue = Object.values(exprValues).find((v) => v.S === ACTIVITY);
      expect(activityValue).toBeDefined();
    });

    it("returns an array of activity records when items are found", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            userId: { N: "7890" },
            userName: { S: "alice" },
            activity: { S: "dishes" },
            timestamp: { N: "1700000000" },
          },
          {
            userId: { N: "7890" },
            userName: { S: "alice" },
            activity: { S: "dishes" },
            timestamp: { N: "1700100000" },
          },
        ],
      });

      const result = await queryUserActivity(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        userId: 7890,
        userName: "alice",
        activity: "dishes",
        timestamp: 1700000000,
      });
      expect(result[1]).toEqual({
        userId: 7890,
        userName: "alice",
        activity: "dishes",
        timestamp: 1700100000,
      });
    });

    it("returns an empty array when no items are found", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      const result = await queryUserActivity(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      expect(result).toEqual([]);
    });

    it("returns an empty array when Items is undefined", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await queryUserActivity(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      expect(result).toEqual([]);
    });

    it("calls send exactly once per invocation", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await queryUserActivity(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ProvisionedThroughputExceededException"));

      await expect(
        queryUserActivity(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP),
      ).rejects.toThrow("ProvisionedThroughputExceededException");
    });
  });

  describe("queryActivityCount", () => {
    it("sends a QueryCommand with the correct table name", async () => {
      mockSend.mockResolvedValueOnce({ Count: 0 });

      await queryActivityCount(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      expect(QueryCommand).toHaveBeenCalledOnce();
      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.TableName).toBe(TABLE_NAME);
    });

    it("queries the userId-timestamp-index GSI", async () => {
      mockSend.mockResolvedValueOnce({ Count: 0 });

      await queryActivityCount(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.IndexName).toBe("userId-timestamp-index");
    });

    it("uses userId as the partition key condition", async () => {
      mockSend.mockResolvedValueOnce({ Count: 0 });

      await queryActivityCount(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      const exprValues = queryInput.ExpressionAttributeValues as Record<string, { N?: string }>;

      const userIdValue = Object.values(exprValues).find((v) => v.N === String(USER_ID));
      expect(userIdValue).toBeDefined();
    });

    it("uses >= sinceTimestamp as the sort key condition", async () => {
      mockSend.mockResolvedValueOnce({ Count: 0 });

      await queryActivityCount(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      const keyCondition = queryInput.KeyConditionExpression as string;

      expect(keyCondition).toMatch(/>=/);

      const exprValues = queryInput.ExpressionAttributeValues as Record<string, { N?: string }>;
      const timestampValue = Object.values(exprValues).find(
        (v) => v.N === String(SINCE_TIMESTAMP),
      );
      expect(timestampValue).toBeDefined();
    });

    it("includes a FilterExpression for the activity name", async () => {
      mockSend.mockResolvedValueOnce({ Count: 0 });

      await queryActivityCount(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.FilterExpression).toBeDefined();

      const filterExpr = queryInput.FilterExpression as string;
      expect(filterExpr).toContain("activity");
    });

    it("returns the count when items are found", async () => {
      mockSend.mockResolvedValueOnce({ Count: 5 });

      const result = await queryActivityCount(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      expect(result).toBe(5);
    });

    it("returns 0 when Count is zero", async () => {
      mockSend.mockResolvedValueOnce({ Count: 0 });

      const result = await queryActivityCount(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      expect(result).toBe(0);
    });

    it("returns 0 when Count is undefined", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await queryActivityCount(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      expect(result).toBe(0);
    });

    it("calls send exactly once per invocation", async () => {
      mockSend.mockResolvedValueOnce({ Count: 0 });

      await queryActivityCount(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP);

      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ValidationException"));

      await expect(
        queryActivityCount(TABLE_NAME, USER_ID, ACTIVITY, SINCE_TIMESTAMP),
      ).rejects.toThrow("ValidationException");
    });
  });
});
