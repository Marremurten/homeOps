import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(function () {
    return { send: mockSend };
  }),
  QueryCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "QueryCommand", input };
  }),
}));

import { isConversationFast } from "@shared/services/fast-conversation.js";

describe("isConversationFast", () => {
  const TABLE_NAME = "test-messages-table";
  const CHAT_ID = "-100123";
  const SENDER_USER_ID = 999;
  const NOW = 1700000060;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeDynamoItem(userId: number, timestamp: number) {
    return {
      userId: { N: String(userId) },
      timestamp: { N: String(timestamp) },
    };
  }

  describe("query parameters", () => {
    it("queries the messages table with ScanIndexForward false and Limit 10", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      const { QueryCommand } = await import("@aws-sdk/client-dynamodb");
      expect(QueryCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          ScanIndexForward: false,
          Limit: 10,
        }),
      );
    });
  });

  describe("returns true when conversation is fast", () => {
    it("returns true when 3+ messages from other users arrived within the last 60 seconds", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          makeDynamoItem(100, NOW - 10),
          makeDynamoItem(101, NOW - 20),
          makeDynamoItem(102, NOW - 30),
        ],
      });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      expect(result).toBe(true);
    });

    it("returns true when exactly 3 messages from others are within 60 seconds", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          makeDynamoItem(100, NOW - 59),
          makeDynamoItem(101, NOW - 30),
          makeDynamoItem(102, NOW - 1),
        ],
      });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      expect(result).toBe(true);
    });

    it("returns true when more than 3 messages from others are within 60 seconds", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          makeDynamoItem(100, NOW - 5),
          makeDynamoItem(101, NOW - 10),
          makeDynamoItem(102, NOW - 15),
          makeDynamoItem(103, NOW - 20),
          makeDynamoItem(104, NOW - 25),
        ],
      });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      expect(result).toBe(true);
    });
  });

  describe("returns false when conversation is not fast", () => {
    it("returns false when fewer than 3 messages from others in last 60 seconds", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          makeDynamoItem(100, NOW - 10),
          makeDynamoItem(101, NOW - 20),
        ],
      });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      expect(result).toBe(false);
    });

    it("returns false when the table query returns no items", async () => {
      mockSend.mockResolvedValueOnce({ Items: undefined });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      expect(result).toBe(false);
    });

    it("returns false when items array is empty", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      expect(result).toBe(false);
    });

    it("returns false when messages from others are older than 60 seconds", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          makeDynamoItem(100, NOW - 61),
          makeDynamoItem(101, NOW - 90),
          makeDynamoItem(102, NOW - 120),
          makeDynamoItem(103, NOW - 200),
        ],
      });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      expect(result).toBe(false);
    });
  });

  describe("filters out messages from senderUserId", () => {
    it("excludes messages from senderUserId when counting recent messages", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          makeDynamoItem(SENDER_USER_ID, NOW - 5),
          makeDynamoItem(SENDER_USER_ID, NOW - 10),
          makeDynamoItem(SENDER_USER_ID, NOW - 15),
          makeDynamoItem(100, NOW - 20),
          makeDynamoItem(101, NOW - 25),
        ],
      });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      // Only 2 messages from other users, so not fast
      expect(result).toBe(false);
    });

    it("counts only non-sender messages toward the threshold", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          makeDynamoItem(SENDER_USER_ID, NOW - 1),
          makeDynamoItem(100, NOW - 5),
          makeDynamoItem(SENDER_USER_ID, NOW - 8),
          makeDynamoItem(101, NOW - 10),
          makeDynamoItem(102, NOW - 15),
          makeDynamoItem(SENDER_USER_ID, NOW - 18),
        ],
      });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      // 3 messages from others (100, 101, 102) within 60s => true
      expect(result).toBe(true);
    });

    it("returns false when all messages are from the sender", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          makeDynamoItem(SENDER_USER_ID, NOW - 5),
          makeDynamoItem(SENDER_USER_ID, NOW - 10),
          makeDynamoItem(SENDER_USER_ID, NOW - 15),
          makeDynamoItem(SENDER_USER_ID, NOW - 20),
          makeDynamoItem(SENDER_USER_ID, NOW - 25),
        ],
      });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      expect(result).toBe(false);
    });
  });

  describe("boundary conditions", () => {
    it("treats a message at exactly 60 seconds ago as within the window", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          makeDynamoItem(100, NOW - 60),
          makeDynamoItem(101, NOW - 30),
          makeDynamoItem(102, NOW - 10),
        ],
      });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      // Message at NOW - 60 is exactly at the boundary; should count
      expect(result).toBe(true);
    });

    it("does not count a message at 61 seconds ago", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          makeDynamoItem(100, NOW - 61),
          makeDynamoItem(101, NOW - 30),
          makeDynamoItem(102, NOW - 10),
        ],
      });

      const result = await isConversationFast(TABLE_NAME, CHAT_ID, SENDER_USER_ID, NOW);

      // Only 2 messages within 60s => false
      expect(result).toBe(false);
    });
  });
});
