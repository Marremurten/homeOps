import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SQSEvent } from "aws-lambda";

const {
  mockSend,
  mockClassifyMessage,
  mockSaveActivity,
  mockGetResponseCount,
  mockIncrementResponseCount,
  mockGetLastResponseAt,
  mockIsConversationFast,
  mockSendTelegramMessage,
  mockGetBotInfo,
  mockEvaluateResponsePolicy,
  mockGetSecret,
  MockUpdateItemCommand,
  mockResolveAliases,
  mockGetEffortEma,
  mockUpdateEffortEma,
  mockUpdatePatternHabit,
  mockUpdateInteractionFrequency,
  mockUpdateIgnoreRate,
  mockGetIgnoreRate,
  mockGetDmStatus,
  mockSetDmOptedIn,
  mockMarkPrompted,
  mockRouteResponse,
  mockHandleClarificationReply,
  mockQueryLastActivity,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockClassifyMessage: vi.fn(),
  mockSaveActivity: vi.fn(),
  mockGetResponseCount: vi.fn(),
  mockIncrementResponseCount: vi.fn(),
  mockGetLastResponseAt: vi.fn(),
  mockIsConversationFast: vi.fn(),
  mockSendTelegramMessage: vi.fn(),
  mockGetBotInfo: vi.fn(),
  mockEvaluateResponsePolicy: vi.fn(),
  mockGetSecret: vi.fn(),
  MockUpdateItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
  mockResolveAliases: vi.fn(),
  mockGetEffortEma: vi.fn(),
  mockUpdateEffortEma: vi.fn(),
  mockUpdatePatternHabit: vi.fn(),
  mockUpdateInteractionFrequency: vi.fn(),
  mockUpdateIgnoreRate: vi.fn(),
  mockGetIgnoreRate: vi.fn(),
  mockGetDmStatus: vi.fn(),
  mockSetDmOptedIn: vi.fn(),
  mockMarkPrompted: vi.fn(),
  mockRouteResponse: vi.fn(),
  mockHandleClarificationReply: vi.fn(),
  mockQueryLastActivity: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  PutItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
  UpdateItemCommand: MockUpdateItemCommand,
}));

vi.mock("@shared/utils/dynamodb-client.js", () => ({
  dynamoDBClient: { send: mockSend },
}));

vi.mock("@shared/utils/require-env.js", () => ({
  requireEnv: (name: string) => process.env[name] ?? `MISSING_${name}`,
}));

vi.mock("@shared/services/classifier.js", () => ({
  classifyMessage: mockClassifyMessage,
}));
vi.mock("@shared/services/activity-store.js", () => ({
  saveActivity: mockSaveActivity,
}));
vi.mock("@shared/services/response-counter.js", () => ({
  getResponseCount: mockGetResponseCount,
  incrementResponseCount: mockIncrementResponseCount,
  getLastResponseAt: mockGetLastResponseAt,
}));
vi.mock("@shared/services/fast-conversation.js", () => ({
  isConversationFast: mockIsConversationFast,
}));
vi.mock("@shared/services/telegram-sender.js", () => ({
  sendMessage: mockSendTelegramMessage,
  getBotInfo: mockGetBotInfo,
}));
vi.mock("@shared/services/response-policy.js", () => ({
  evaluateResponsePolicy: mockEvaluateResponsePolicy,
}));
vi.mock("@shared/utils/secrets.js", () => ({
  getSecret: mockGetSecret,
}));
vi.mock("@shared/services/alias-resolver.js", () => ({
  resolveAliases: mockResolveAliases,
}));
vi.mock("@shared/services/effort-tracker.js", () => ({
  getEffortEma: mockGetEffortEma,
  updateEffortEma: mockUpdateEffortEma,
}));
vi.mock("@shared/services/pattern-tracker.js", () => ({
  updatePatternHabit: mockUpdatePatternHabit,
}));
vi.mock("@shared/services/preference-tracker.js", () => ({
  updateInteractionFrequency: mockUpdateInteractionFrequency,
  updateIgnoreRate: mockUpdateIgnoreRate,
  getIgnoreRate: mockGetIgnoreRate,
}));
vi.mock("@shared/services/dm-status.js", () => ({
  getDmStatus: mockGetDmStatus,
  setDmOptedIn: mockSetDmOptedIn,
  markPrompted: mockMarkPrompted,
}));
vi.mock("@shared/services/channel-router.js", () => ({
  routeResponse: mockRouteResponse,
}));
vi.mock("@shared/services/clarification-handler.js", () => ({
  handleClarificationReply: mockHandleClarificationReply,
}));
vi.mock("@shared/services/memory-query.js", () => ({
  queryLastActivity: mockQueryLastActivity,
}));

function makeSqsEvent(bodyOverrides?: Partial<Record<string, unknown>>): SQSEvent {
  const body = {
    chatId: "-100123",
    messageId: 1,
    userId: 111,
    userName: "Test",
    text: "Hello",
    timestamp: 1234567890,
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
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.MESSAGES_TABLE_NAME = "test-messages-table";
    process.env.ACTIVITIES_TABLE_NAME = "test-activities-table";
    process.env.RESPONSE_COUNTERS_TABLE_NAME = "test-counters-table";
    process.env.HOMEOPS_TABLE_NAME = "test-homeops-table";
    process.env.OPENAI_API_KEY_ARN =
      "arn:aws:secretsmanager:eu-north-1:123:secret:openai-key";
    process.env.TELEGRAM_BOT_TOKEN_ARN =
      "arn:aws:secretsmanager:eu-north-1:123:secret:bot-token";

    mockSend.mockResolvedValue({});
    mockGetSecret.mockResolvedValue("test-secret-value");
    mockClassifyMessage.mockResolvedValue({
      type: "chore",
      activity: "städa",
      effort: "medium",
      confidence: 0.92,
    });
    mockSaveActivity.mockResolvedValue("01HTESTACTIVITYID");
    mockEvaluateResponsePolicy.mockResolvedValue({
      respond: false,
      reason: "none",
    });
    mockSendTelegramMessage.mockResolvedValue({ ok: true, messageId: 999 });
    mockGetBotInfo.mockResolvedValue({ id: 123, username: "testbot" });
    mockIncrementResponseCount.mockResolvedValue(undefined);
    mockResolveAliases.mockResolvedValue({ resolvedText: "Hello", appliedAliases: [] });
    mockGetEffortEma.mockResolvedValue(null);
    mockUpdateEffortEma.mockResolvedValue(undefined);
    mockUpdatePatternHabit.mockResolvedValue(undefined);
    mockUpdateInteractionFrequency.mockResolvedValue(undefined);
    mockUpdateIgnoreRate.mockResolvedValue(undefined);
    mockGetIgnoreRate.mockResolvedValue(null);
    mockGetDmStatus.mockResolvedValue(null);
    mockSetDmOptedIn.mockResolvedValue(undefined);
    mockMarkPrompted.mockResolvedValue(undefined);
    mockRouteResponse.mockReturnValue("group");
    mockHandleClarificationReply.mockResolvedValue({ handled: false, reason: "not_clarification" });
    mockQueryLastActivity.mockResolvedValue(null);
  });

  afterEach(() => {
    // Restore all env vars to original state
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
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
            timestamp: { N: "1234567890" },
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

  describe("SQSBatchResponse", () => {
    it("returns empty batchItemFailures on success", async () => {
      const handler = await importHandler();
      const result = await handler(makeSqsEvent());

      expect(result).toEqual({ batchItemFailures: [] });
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
    it("returns batchItemFailures for non-ConditionalCheckFailedException errors", async () => {
      const error = new Error("Internal server error");
      error.name = "InternalServerError";
      mockSend.mockRejectedValue(error);

      const handler = await importHandler();
      const result = await handler(makeSqsEvent());

      expect(result).toEqual({
        batchItemFailures: [{ itemIdentifier: "sqs-msg-id" }],
      });
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

  describe("classification pipeline", () => {
    it("calls classifyMessage with message text and OpenAI API key after DynamoDB write", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent({ text: "Jag städade köket" }));

      expect(mockGetSecret).toHaveBeenCalledWith(
        "arn:aws:secretsmanager:eu-north-1:123:secret:openai-key",
      );
      expect(mockClassifyMessage).toHaveBeenCalledWith(
        "Jag städade köket",
        "test-secret-value",
        expect.anything(),
      );
    });

    it("calls saveActivity when classification returns chore", async () => {
      mockClassifyMessage.mockResolvedValue({
        type: "chore",
        activity: "städa",
        effort: "medium",
        confidence: 0.92,
      });

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockSaveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: "test-activities-table",
          chatId: "-100123",
          messageId: 1,
          userId: 111,
          userName: "Test",
          classification: {
            type: "chore",
            activity: "städa",
            effort: "medium",
            confidence: 0.92,
          },
          timestamp: 1234567890,
        }),
      );
    });

    it("calls saveActivity when classification returns recovery", async () => {
      mockClassifyMessage.mockResolvedValue({
        type: "recovery",
        activity: "vila",
        effort: "low",
        confidence: 0.88,
      });

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockSaveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: "test-activities-table",
          chatId: "-100123",
          classification: {
            type: "recovery",
            activity: "vila",
            effort: "low",
            confidence: 0.88,
          },
        }),
      );
    });

    it("does not call saveActivity or evaluateResponsePolicy when classification returns none", async () => {
      mockClassifyMessage.mockResolvedValue({
        type: "none",
        activity: "",
        effort: "low",
        confidence: 0,
      });

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockSaveActivity).not.toHaveBeenCalled();
      expect(mockEvaluateResponsePolicy).not.toHaveBeenCalled();
    });

    it("calls evaluateResponsePolicy with classification result and context when type is not none", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockEvaluateResponsePolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          classification: {
            type: "chore",
            activity: "städa",
            effort: "medium",
            confidence: 0.92,
          },
          chatId: "-100123",
          senderUserId: 111,
          currentTimestamp: 1234567890,
          messagesTableName: "test-messages-table",
          countersTableName: "test-counters-table",
        }),
      );
    });

    it("calls sendMessage when response policy returns respond true", async () => {
      mockEvaluateResponsePolicy.mockResolvedValue({
        respond: true,
        text: "Noterat ✓",
      });

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockGetSecret).toHaveBeenCalledWith(
        "arn:aws:secretsmanager:eu-north-1:123:secret:bot-token",
      );
      expect(mockSendTelegramMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "test-secret-value",
          chatId: -100123,
          text: "Noterat ✓",
          replyToMessageId: 1,
        }),
      );
    });

    it("does not call sendMessage when response policy returns respond false", async () => {
      mockEvaluateResponsePolicy.mockResolvedValue({
        respond: false,
        reason: "quiet_hours",
      });

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    });

    it("calls incrementResponseCount after successful Telegram send", async () => {
      mockEvaluateResponsePolicy.mockResolvedValue({
        respond: true,
        text: "Noterat ✓",
      });
      mockSendTelegramMessage.mockResolvedValue({ ok: true, messageId: 999 });

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockIncrementResponseCount).toHaveBeenCalled();
    });

    it("updates activity with botMessageId after successful Telegram send", async () => {
      mockEvaluateResponsePolicy.mockResolvedValue({
        respond: true,
        text: "Noterat ✓",
      });
      mockSendTelegramMessage.mockResolvedValue({ ok: true, messageId: 999 });
      mockSaveActivity.mockResolvedValue("01HTESTACTIVITYID");

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(MockUpdateItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: "test-activities-table",
          Key: {
            chatId: { S: "-100123" },
            activityId: { S: "01HTESTACTIVITYID" },
          },
          UpdateExpression: "SET botMessageId = :mid",
          ExpressionAttributeValues: {
            ":mid": { N: "999" },
          },
        }),
      );
    });

    it("continues without error when classifyMessage throws", async () => {
      mockClassifyMessage.mockRejectedValue(new Error("OpenAI API error"));

      const handler = await importHandler();

      await expect(handler(makeSqsEvent())).resolves.not.toThrow();
      expect(mockSaveActivity).not.toHaveBeenCalled();
    });

    it("continues without error when Telegram send returns ok false", async () => {
      mockEvaluateResponsePolicy.mockResolvedValue({
        respond: true,
        text: "Noterat ✓",
      });
      mockSendTelegramMessage.mockResolvedValue({
        ok: false,
        error: "chat not found",
      });

      const handler = await importHandler();

      await expect(handler(makeSqsEvent())).resolves.not.toThrow();
      expect(mockIncrementResponseCount).not.toHaveBeenCalled();
    });

    it("continues without error when saveActivity throws", async () => {
      mockSaveActivity.mockRejectedValue(new Error("DynamoDB write failed"));

      const handler = await importHandler();

      await expect(handler(makeSqsEvent())).resolves.not.toThrow();
    });

    it("does not call evaluateResponsePolicy when saveActivity throws", async () => {
      mockSaveActivity.mockRejectedValue(new Error("DynamoDB write failed"));

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockEvaluateResponsePolicy).not.toHaveBeenCalled();
    });

    it("reads OPENAI_API_KEY_ARN env var and fetches secret via getSecret", async () => {
      process.env.OPENAI_API_KEY_ARN =
        "arn:aws:secretsmanager:eu-north-1:123:secret:custom-openai-key";

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockGetSecret).toHaveBeenCalledWith(
        "arn:aws:secretsmanager:eu-north-1:123:secret:custom-openai-key",
      );
    });

    it("reads TELEGRAM_BOT_TOKEN_ARN env var and fetches secret when responding", async () => {
      process.env.TELEGRAM_BOT_TOKEN_ARN =
        "arn:aws:secretsmanager:eu-north-1:123:secret:custom-bot-token";
      mockEvaluateResponsePolicy.mockResolvedValue({
        respond: true,
        text: "Noterat ✓",
      });

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockGetSecret).toHaveBeenCalledWith(
        "arn:aws:secretsmanager:eu-north-1:123:secret:custom-bot-token",
      );
    });
  });

  describe("Phase 3: Learning pipeline integration", () => {
    it("calls setDmOptedIn and sends welcome message for /start in private chat", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent({ chatType: "private", text: "/start" }));

      expect(mockSetDmOptedIn).toHaveBeenCalledWith(
        "test-homeops-table",
        expect.any(String),
        expect.any(Number),
      );
      expect(mockSendTelegramMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(""),
        }),
      );
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it("skips classification for non-/start private chat messages", async () => {
      const handler = await importHandler();
      await handler(makeSqsEvent({ chatType: "private", text: "hello" }));

      expect(mockClassifyMessage).not.toHaveBeenCalled();
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    });

    it("calls handleClarificationReply when replying to bot clarification", async () => {
      mockHandleClarificationReply.mockResolvedValue({
        handled: true,
        action: "confirmed",
        activity: "diskning",
      });

      const handler = await importHandler();
      await handler(
        makeSqsEvent({
          text: "Ja",
          replyToIsBot: true,
          replyToText: "Menade du diskning?",
        }),
      );

      expect(mockHandleClarificationReply).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: "test-homeops-table",
          chatId: "-100123",
          replyToText: "Menade du diskning?",
        }),
      );
      expect(mockClassifyMessage).not.toHaveBeenCalled();
    });

    it("calls resolveAliases before classification", async () => {
      mockResolveAliases.mockResolvedValue({
        resolvedText: "jag diskning",
        appliedAliases: [
          { alias: "disk", canonicalActivity: "diskning" },
        ],
      });

      const handler = await importHandler();
      await handler(makeSqsEvent({ text: "jag disk" }));

      expect(mockResolveAliases).toHaveBeenCalledWith(
        "test-homeops-table",
        "-100123",
        "jag disk",
      );
      expect(mockClassifyMessage).toHaveBeenCalledWith(
        "jag diskning",
        expect.any(String),
        expect.anything(),
      );
    });

    it("passes effort EMA context to classifier when available", async () => {
      mockGetEffortEma.mockResolvedValue({ ema: 2.5, sampleCount: 10 });
      mockResolveAliases.mockResolvedValue({
        resolvedText: "jag disk",
        appliedAliases: [
          { alias: "disk", canonicalActivity: "diskning" },
        ],
      });

      const handler = await importHandler();
      await handler(makeSqsEvent({ text: "jag disk" }));

      expect(mockClassifyMessage).toHaveBeenCalledWith(
        "jag disk",
        expect.any(String),
        expect.objectContaining({
          aliases: [{ alias: "disk", canonicalActivity: "diskning" }],
          effortEma: expect.objectContaining({ ema: 2.5 }),
        }),
      );
    });

    it("calls updateEffortEma, updatePatternHabit, and updateInteractionFrequency after saving activity", async () => {
      mockClassifyMessage.mockResolvedValue({
        type: "chore",
        activity: "städa",
        effort: "medium",
        confidence: 0.92,
      });
      mockSaveActivity.mockResolvedValue("01HTESTACTIVITYID");

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockUpdateEffortEma).toHaveBeenCalled();
      expect(mockUpdatePatternHabit).toHaveBeenCalled();
      expect(mockUpdateInteractionFrequency).toHaveBeenCalled();
    });

    it("passes homeopsTableName and userId to evaluateResponsePolicy", async () => {
      mockClassifyMessage.mockResolvedValue({
        type: "chore",
        activity: "städa",
        effort: "medium",
        confidence: 0.92,
      });
      mockSaveActivity.mockResolvedValue("01HTESTACTIVITYID");

      const handler = await importHandler();
      await handler(makeSqsEvent());

      expect(mockEvaluateResponsePolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          homeopsTableName: "test-homeops-table",
          userId: 111,
        }),
      );
    });
  });
});
