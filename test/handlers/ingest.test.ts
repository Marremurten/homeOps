import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- SQS mock setup ---
const { sqsSendMock, getSecretMock } = vi.hoisted(() => ({
  sqsSendMock: vi.fn(),
  getSecretMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-sqs", () => {
  return {
    SQSClient: vi.fn().mockImplementation(function () {
      return { send: sqsSendMock };
    }),
    SendMessageCommand: vi.fn().mockImplementation(function (input: unknown) {
      return { _type: "SendMessageCommand", input };
    }),
  };
});

// --- Secrets mock setup ---

vi.mock("@shared/utils/secrets.js", () => {
  return {
    getSecret: getSecretMock,
  };
});

import { handler } from "../../src/handlers/ingest/index.js";

// --- Helpers ---

const TEST_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue";
const TEST_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789:secret:webhook-secret";
const VALID_TOKEN = "valid-token";

function makeEvent(options: {
  token?: string;
  body?: unknown;
  omitTokenHeader?: boolean;
}) {
  const headers: Record<string, string> = {};
  if (!options.omitTokenHeader && options.token !== undefined) {
    headers["x-telegram-bot-api-secret-token"] = options.token;
  }

  return {
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : "{}",
    isBase64Encoded: false,
  } as any;
}

function makeTextUpdate(overrides?: Partial<{
  chatId: number;
  messageId: number;
  userId: number;
  userName: string;
  text: string;
  date: number;
}>) {
  const {
    chatId = 12345,
    messageId = 100,
    userId = 67890,
    userName = "testuser",
    text = "Hello, bot!",
    date = 1700000000,
  } = overrides ?? {};

  return {
    update_id: 999,
    message: {
      message_id: messageId,
      date,
      chat: { id: chatId, type: "private" },
      from: { id: userId, is_bot: false, first_name: "Test", username: userName },
      text,
    },
  };
}

describe("Ingest Lambda handler", () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.SQS_QUEUE_URL = TEST_QUEUE_URL;
    process.env.WEBHOOK_SECRET_ARN = TEST_SECRET_ARN;
    vi.clearAllMocks();
    getSecretMock.mockResolvedValue(VALID_TOKEN);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ---- Authentication tests ----

  describe("authentication", () => {
    it("returns 401 when x-telegram-bot-api-secret-token header is missing", async () => {
      const event = makeEvent({ omitTokenHeader: true });

      const response = await handler(event);

      expect(response.statusCode).toBe(401);
    });

    it("returns 401 when x-telegram-bot-api-secret-token header has wrong value", async () => {
      const event = makeEvent({
        token: "wrong-token",
        body: makeTextUpdate(),
      });

      const response = await handler(event);

      expect(response.statusCode).toBe(401);
    });
  });

  // ---- Valid text message ----

  describe("valid text message update", () => {
    it("returns 200 and calls SQS SendMessage", async () => {
      sqsSendMock.mockResolvedValueOnce({});
      const update = makeTextUpdate();
      const event = makeEvent({ token: VALID_TOKEN, body: update });

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(sqsSendMock).toHaveBeenCalledOnce();
    });

    it("SQS message body contains the expected message fields", async () => {
      sqsSendMock.mockResolvedValueOnce({});
      const update = makeTextUpdate({
        chatId: 111,
        messageId: 222,
        userId: 333,
        userName: "alice",
        text: "test message",
        date: 1700000000,
      });
      const event = makeEvent({ token: VALID_TOKEN, body: update });

      await handler(event);

      expect(sqsSendMock).toHaveBeenCalledOnce();

      // Extract the SendMessageCommand input
      const { SendMessageCommand } = await import("@aws-sdk/client-sqs");
      const commandCall = vi.mocked(SendMessageCommand).mock.calls[0][0] as any;

      expect(commandCall.QueueUrl).toBe(TEST_QUEUE_URL);

      const messageBody = JSON.parse(commandCall.MessageBody);
      expect(messageBody).toEqual(
        expect.objectContaining({
          chatId: 111,
          messageId: 222,
          userId: 333,
          userName: "alice",
          text: "test message",
          timestamp: 1700000000,
        }),
      );
    });
  });

  // ---- Non-text updates (should NOT enqueue) ----

  describe("non-text updates", () => {
    it("returns 200 and does NOT call SQS for edited_message updates", async () => {
      const update = {
        update_id: 999,
        edited_message: {
          message_id: 100,
          date: 1700000000,
          chat: { id: 12345, type: "private" },
          from: { id: 67890, is_bot: false, first_name: "Test" },
          text: "edited text",
          edit_date: 1700000001,
        },
      };
      const event = makeEvent({ token: VALID_TOKEN, body: update });

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(sqsSendMock).not.toHaveBeenCalled();
    });

    it("returns 200 and does NOT call SQS when there is no message field", async () => {
      const update = {
        update_id: 999,
        callback_query: {
          id: "abc",
          from: { id: 67890, is_bot: false, first_name: "Test" },
          chat_instance: "xyz",
          data: "button_click",
        },
      };
      const event = makeEvent({ token: VALID_TOKEN, body: update });

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(sqsSendMock).not.toHaveBeenCalled();
    });
  });

  // ---- Reply metadata ----

  describe("reply metadata extraction", () => {
    it("includes replyToMessageId and replyToIsBot when reply_to_message is present", async () => {
      sqsSendMock.mockResolvedValueOnce({});
      const update = {
        update_id: 999,
        message: {
          message_id: 100,
          date: 1700000000,
          chat: { id: 12345, type: "private" },
          from: { id: 67890, is_bot: false, first_name: "Test", username: "testuser" },
          text: "Hello",
          reply_to_message: {
            message_id: 50,
            date: 1699999000,
            chat: { id: 12345, type: "private" },
            from: { id: 99999, is_bot: true, first_name: "Bot" },
            text: "Previous message",
          },
        },
      };
      const event = makeEvent({ token: VALID_TOKEN, body: update });

      await handler(event);

      expect(sqsSendMock).toHaveBeenCalledOnce();

      const { SendMessageCommand } = await import("@aws-sdk/client-sqs");
      const commandCall = vi.mocked(SendMessageCommand).mock.calls[0][0] as any;
      const messageBody = JSON.parse(commandCall.MessageBody);

      expect(messageBody.replyToMessageId).toBe(50);
      expect(messageBody.replyToIsBot).toBe(true);
    });

    it("does not include replyToMessageId or replyToIsBot when there is no reply_to_message", async () => {
      sqsSendMock.mockResolvedValueOnce({});
      const update = makeTextUpdate();
      const event = makeEvent({ token: VALID_TOKEN, body: update });

      await handler(event);

      expect(sqsSendMock).toHaveBeenCalledOnce();

      const { SendMessageCommand } = await import("@aws-sdk/client-sqs");
      const commandCall = vi.mocked(SendMessageCommand).mock.calls[0][0] as any;
      const messageBody = JSON.parse(commandCall.MessageBody);

      expect(messageBody).not.toHaveProperty("replyToMessageId");
      expect(messageBody).not.toHaveProperty("replyToIsBot");
    });

    it("defaults replyToIsBot to false when reply_to_message has no from field", async () => {
      sqsSendMock.mockResolvedValueOnce({});
      const update = {
        update_id: 999,
        message: {
          message_id: 100,
          date: 1700000000,
          chat: { id: 12345, type: "private" },
          from: { id: 67890, is_bot: false, first_name: "Test", username: "testuser" },
          text: "Hello",
          reply_to_message: {
            message_id: 50,
            date: 1699999000,
            chat: { id: 12345, type: "private" },
            text: "Previous message",
          },
        },
      };
      const event = makeEvent({ token: VALID_TOKEN, body: update });

      await handler(event);

      expect(sqsSendMock).toHaveBeenCalledOnce();

      const { SendMessageCommand } = await import("@aws-sdk/client-sqs");
      const commandCall = vi.mocked(SendMessageCommand).mock.calls[0][0] as any;
      const messageBody = JSON.parse(commandCall.MessageBody);

      expect(messageBody.replyToMessageId).toBe(50);
      expect(messageBody.replyToIsBot).toBe(false);
    });
  });

  // ---- SQS failure ----

  describe("SQS failure", () => {
    it("returns 500 when SQS SendMessage throws", async () => {
      sqsSendMock.mockRejectedValueOnce(new Error("SQS unavailable"));
      const update = makeTextUpdate();
      const event = makeEvent({ token: VALID_TOKEN, body: update });

      const response = await handler(event);

      expect(response.statusCode).toBe(500);
    });
  });
});
