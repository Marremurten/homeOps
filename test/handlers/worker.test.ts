import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SQSEvent } from "aws-lambda";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  PutItemCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

function makeSqsEvent(bodyOverrides?: Partial<Record<string, unknown>>): SQSEvent {
  const body = {
    chatId: "-100123",
    messageId: 1,
    userId: 111,
    userName: "Test",
    text: "Hello",
    timestamp: 1234567890000,
    ...bodyOverrides,
  };
  return {
    Records: [
      {
        messageId: "sqs-msg-id",
        body: JSON.stringify(body),
        receiptHandle: "handle",
        attributes: {} as any,
        messageAttributes: {},
        md5OfBody: "",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:eu-north-1:123:queue",
        awsRegion: "eu-north-1",
      },
    ],
  };
}

describe("Worker Lambda handler", () => {
  const originalTableName = process.env.MESSAGES_TABLE_NAME;

  beforeEach(() => {
    process.env.MESSAGES_TABLE_NAME = "test-messages-table";
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  afterEach(() => {
    if (originalTableName !== undefined) {
      process.env.MESSAGES_TABLE_NAME = originalTableName;
    } else {
      delete process.env.MESSAGES_TABLE_NAME;
    }
  });

  async function importHandler() {
    const mod = await import("../../src/handlers/worker/index.js");
    return mod.handler;
  }

  describe("writes message to DynamoDB with correct attributes", () => {
    it("sends a PutItemCommand with chatId as S attribute", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: "test-messages-table",
          Item: expect.objectContaining({
            chatId: { S: "-100123" },
          }),
        }),
      );
    });

    it("sends messageId as N attribute", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            messageId: { N: "1" },
          }),
        }),
      );
    });

    it("sends userId as N attribute", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            userId: { N: "111" },
          }),
        }),
      );
    });

    it("sends userName as S attribute", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            userName: { S: "Test" },
          }),
        }),
      );
    });

    it("sends text as S attribute", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            text: { S: "Hello" },
          }),
        }),
      );
    });

    it("sends timestamp as N attribute", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            timestamp: { N: "1234567890000" },
          }),
        }),
      );
    });

    it("sends raw as S attribute containing the full JSON body", async () => {
      const handler = await importHandler();
      const event = makeSqsEvent();
      await handler(event);

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            raw: { S: event.Records[0].body },
          }),
        }),
      );
    });

    it("sends createdAt as S attribute in ISO format", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(PutItemCommand).mock.calls[0][0] as any;
      expect(call.Item.createdAt).toBeDefined();
      expect(call.Item.createdAt.S).toBeDefined();
      // createdAt should be a valid ISO date string
      expect(new Date(call.Item.createdAt.S).toISOString()).toBe(call.Item.createdAt.S);
    });

    it("sends ttl as N attribute", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(PutItemCommand).mock.calls[0][0] as any;
      expect(call.Item.ttl).toBeDefined();
      expect(call.Item.ttl.N).toBeDefined();
      // TTL should be a numeric string
      expect(Number(call.Item.ttl.N)).not.toBeNaN();
    });
  });

  describe("TTL computation", () => {
    it("computes ttl as createdAt + 90 days in Unix epoch seconds", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(PutItemCommand).mock.calls[0][0] as any;

      const createdAtMs = new Date(call.Item.createdAt.S).getTime();
      const ninetyDaysInSeconds = 90 * 24 * 60 * 60;
      const expectedTtl = Math.floor(createdAtMs / 1000) + ninetyDaysInSeconds;

      expect(Number(call.Item.ttl.N)).toBe(expectedTtl);
    });
  });

  describe("ConditionalCheckFailedException handling", () => {
    it("catches ConditionalCheckFailedException and treats as success", async () => {
      const error = new Error("ConditionalCheckFailedException");
      error.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValue(error);

      const handler = await importHandler();

      // Should NOT throw
      await expect(handler(makeSqsEvent())).resolves.not.toThrow();
    });
  });

  describe("other DynamoDB errors", () => {
    it("throws on non-ConditionalCheckFailedException errors so SQS retries", async () => {
      const error = new Error("Internal server error");
      error.name = "InternalServerError";
      mockSend.mockRejectedValue(error);

      const handler = await importHandler();

      await expect(handler(makeSqsEvent())).rejects.toThrow("Internal server error");
    });
  });

  describe("SQS event record processing", () => {
    it("parses the SQS record body as JSON", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent({ text: "parsed correctly" }));

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            text: { S: "parsed correctly" },
          }),
        }),
      );
    });

    it("uses the table name from MESSAGES_TABLE_NAME env var", async () => {
      process.env.MESSAGES_TABLE_NAME = "custom-table";
      const handler = await importHandler();
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: "custom-table",
        }),
      );
    });
  });
});
