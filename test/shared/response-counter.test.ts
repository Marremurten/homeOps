import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(function () {
    return { send: mockSend };
  }),
  GetItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "GetItemCommand", input };
  }),
  UpdateItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "UpdateItemCommand", input };
  }),
}));

import {
  getResponseCount,
  incrementResponseCount,
  getLastResponseAt,
} from "@shared/services/response-counter.js";

const TABLE_NAME = "test-response-counter-table";
const CHAT_ID = "-100999";
const DATE = "2026-02-17";

describe("response-counter service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-17T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getResponseCount", () => {
    it("sends a GetItemCommand with correct table, chatId, and date", async () => {
      mockSend.mockResolvedValueOnce({ Item: { count: { N: "5" } } });

      await getResponseCount(TABLE_NAME, CHAT_ID, DATE);

      const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(GetItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            chatId: { S: CHAT_ID },
            date: { S: DATE },
          }),
        }),
      );
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("returns the count number when item exists", async () => {
      mockSend.mockResolvedValueOnce({ Item: { count: { N: "7" } } });

      const result = await getResponseCount(TABLE_NAME, CHAT_ID, DATE);

      expect(result).toBe(7);
    });

    it("returns 0 when item does not exist", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await getResponseCount(TABLE_NAME, CHAT_ID, DATE);

      expect(result).toBe(0);
    });

    it("returns 0 when item exists but has no count field", async () => {
      mockSend.mockResolvedValueOnce({ Item: { chatId: { S: CHAT_ID } } });

      const result = await getResponseCount(TABLE_NAME, CHAT_ID, DATE);

      expect(result).toBe(0);
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ProvisionedThroughputExceededException"));

      await expect(getResponseCount(TABLE_NAME, CHAT_ID, DATE)).rejects.toThrow(
        "ProvisionedThroughputExceededException",
      );
    });
  });

  describe("incrementResponseCount", () => {
    it("sends an UpdateItemCommand with ADD count expression", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementResponseCount(TABLE_NAME, CHAT_ID, DATE);

      const { UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(UpdateItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            chatId: { S: CHAT_ID },
            date: { S: DATE },
          }),
        }),
      );
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("uses ADD count :inc in the update expression", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementResponseCount(TABLE_NAME, CHAT_ID, DATE);

      const { UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(UpdateItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const updateExpr = call.UpdateExpression as string;

      expect(updateExpr).toContain("ADD");
      expect(updateExpr).toMatch(/count\s+:inc/);
    });

    it("sets updatedAt in the update expression", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementResponseCount(TABLE_NAME, CHAT_ID, DATE);

      const { UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(UpdateItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const updateExpr = call.UpdateExpression as string;

      expect(updateExpr).toContain("updatedAt");
    });

    it("sets lastResponseAt in the update expression", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementResponseCount(TABLE_NAME, CHAT_ID, DATE);

      const { UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(UpdateItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const updateExpr = call.UpdateExpression as string;

      expect(updateExpr).toContain("lastResponseAt");
    });

    it("sets ttl in the update expression", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementResponseCount(TABLE_NAME, CHAT_ID, DATE);

      const { UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(UpdateItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const updateExpr = call.UpdateExpression as string;

      expect(updateExpr).toContain("ttl");
    });

    it("computes TTL as current time + 7 days in Unix epoch seconds", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementResponseCount(TABLE_NAME, CHAT_ID, DATE);

      const { UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(UpdateItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const exprValues = call.ExpressionAttributeValues as Record<string, { N?: string; S?: string }>;

      const sevenDaysInSeconds = 7 * 24 * 60 * 60;
      const nowEpochSeconds = Math.floor(new Date("2026-02-17T12:00:00.000Z").getTime() / 1000);
      const expectedTtl = nowEpochSeconds + sevenDaysInSeconds;

      // Find the TTL value in expression attribute values
      const ttlValue = exprValues[":ttl"] ?? exprValues[":t"];
      expect(ttlValue).toBeDefined();
      expect(Number(ttlValue!.N)).toBe(expectedTtl);
    });

    it("sets :inc expression attribute value to 1", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementResponseCount(TABLE_NAME, CHAT_ID, DATE);

      const { UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(UpdateItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const exprValues = call.ExpressionAttributeValues as Record<string, { N?: string }>;

      expect(exprValues[":inc"]).toBeDefined();
      expect(exprValues[":inc"].N).toBe("1");
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ConditionalCheckFailedException"));

      await expect(incrementResponseCount(TABLE_NAME, CHAT_ID, DATE)).rejects.toThrow(
        "ConditionalCheckFailedException",
      );
    });
  });

  describe("getLastResponseAt", () => {
    it("sends a GetItemCommand with correct table, chatId, and date", async () => {
      mockSend.mockResolvedValueOnce({
        Item: { lastResponseAt: { S: "2026-02-17T11:30:00.000Z" } },
      });

      await getLastResponseAt(TABLE_NAME, CHAT_ID, DATE);

      const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(GetItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            chatId: { S: CHAT_ID },
            date: { S: DATE },
          }),
        }),
      );
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("returns ISO string when lastResponseAt exists", async () => {
      mockSend.mockResolvedValueOnce({
        Item: { lastResponseAt: { S: "2026-02-17T11:30:00.000Z" } },
      });

      const result = await getLastResponseAt(TABLE_NAME, CHAT_ID, DATE);

      expect(result).toBe("2026-02-17T11:30:00.000Z");
    });

    it("returns null when item does not exist", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await getLastResponseAt(TABLE_NAME, CHAT_ID, DATE);

      expect(result).toBeNull();
    });

    it("returns null when item exists but lastResponseAt field is missing", async () => {
      mockSend.mockResolvedValueOnce({
        Item: { chatId: { S: CHAT_ID }, count: { N: "3" } },
      });

      const result = await getLastResponseAt(TABLE_NAME, CHAT_ID, DATE);

      expect(result).toBeNull();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ResourceNotFoundException"));

      await expect(getLastResponseAt(TABLE_NAME, CHAT_ID, DATE)).rejects.toThrow(
        "ResourceNotFoundException",
      );
    });
  });
});
