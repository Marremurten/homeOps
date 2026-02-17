import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Hoisted mocks ---

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  GetItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "GetItemCommand", input };
  }),
  PutItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "PutItemCommand", input };
  }),
  UpdateItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "UpdateItemCommand", input };
  }),
}));

vi.mock("@shared/utils/dynamodb-client.js", () => ({
  dynamoDBClient: { send: mockSend },
}));

// --- Constants ---

const TABLE_NAME = "test-dm-status-table";
const USER_ID = "12345";
const PRIVATE_CHAT_ID = 67890;

// --- Tests ---

describe("dm-status service", () => {
  let getDmStatus: typeof import("@shared/services/dm-status.js").getDmStatus;
  let setDmOptedIn: typeof import("@shared/services/dm-status.js").setDmOptedIn;
  let markPrompted: typeof import("@shared/services/dm-status.js").markPrompted;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@shared/services/dm-status.js");
    getDmStatus = mod.getDmStatus;
    setDmOptedIn = mod.setDmOptedIn;
    markPrompted = mod.markPrompted;
  });

  describe("getDmStatus", () => {
    it("sends a GetItemCommand with correct table and key", async () => {
      mockSend.mockResolvedValueOnce({});

      await getDmStatus(TABLE_NAME, USER_ID);

      const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(GetItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            pk: { S: `DM#${USER_ID}` },
            sk: { S: "STATUS" },
          }),
        }),
      );
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("returns null when no record exists", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await getDmStatus(TABLE_NAME, USER_ID);

      expect(result).toBeNull();
    });

    it("returns optedIn and privateChatId when record exists with opted in", async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `DM#${USER_ID}` },
          sk: { S: "STATUS" },
          optedIn: { BOOL: true },
          privateChatId: { N: String(PRIVATE_CHAT_ID) },
        },
      });

      const result = await getDmStatus(TABLE_NAME, USER_ID);

      expect(result).toEqual({
        optedIn: true,
        privateChatId: PRIVATE_CHAT_ID,
      });
    });

    it("returns optedIn false when record exists but not opted in", async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `DM#${USER_ID}` },
          sk: { S: "STATUS" },
          optedIn: { BOOL: false },
        },
      });

      const result = await getDmStatus(TABLE_NAME, USER_ID);

      expect(result).not.toBeNull();
      expect(result!.optedIn).toBe(false);
    });

    it("returns privateChatId as a number", async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `DM#${USER_ID}` },
          sk: { S: "STATUS" },
          optedIn: { BOOL: true },
          privateChatId: { N: "99999" },
        },
      });

      const result = await getDmStatus(TABLE_NAME, USER_ID);

      expect(result!.privateChatId).toBe(99999);
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ResourceNotFoundException"));

      await expect(getDmStatus(TABLE_NAME, USER_ID)).rejects.toThrow(
        "ResourceNotFoundException",
      );
    });
  });

  describe("setDmOptedIn", () => {
    it("sends a PutItemCommand with correct table and key", async () => {
      mockSend.mockResolvedValueOnce({});

      await setDmOptedIn(TABLE_NAME, USER_ID, PRIVATE_CHAT_ID);

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledOnce();
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as unknown as Record<string, unknown>;
      expect(putInput.TableName).toBe(TABLE_NAME);
    });

    it("writes PK as DM#<userId> and SK as STATUS", async () => {
      mockSend.mockResolvedValueOnce({});

      await setDmOptedIn(TABLE_NAME, USER_ID, PRIVATE_CHAT_ID);

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as unknown as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string }>;
      expect(item.pk).toEqual({ S: `DM#${USER_ID}` });
      expect(item.sk).toEqual({ S: "STATUS" });
    });

    it("sets optedIn to true", async () => {
      mockSend.mockResolvedValueOnce({});

      await setDmOptedIn(TABLE_NAME, USER_ID, PRIVATE_CHAT_ID);

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as unknown as Record<string, unknown>;
      const item = putInput.Item as Record<string, { BOOL?: boolean }>;
      expect(item.optedIn).toEqual({ BOOL: true });
    });

    it("stores privateChatId as a number attribute", async () => {
      mockSend.mockResolvedValueOnce({});

      await setDmOptedIn(TABLE_NAME, USER_ID, PRIVATE_CHAT_ID);

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as unknown as Record<string, unknown>;
      const item = putInput.Item as Record<string, { N?: string }>;
      expect(item.privateChatId).toEqual({ N: String(PRIVATE_CHAT_ID) });
    });

    it("includes an optedInAt timestamp", async () => {
      mockSend.mockResolvedValueOnce({});

      await setDmOptedIn(TABLE_NAME, USER_ID, PRIVATE_CHAT_ID);

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as unknown as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string }>;
      expect(item.optedInAt).toBeDefined();
      expect(item.optedInAt.S).toBeDefined();
    });

    it("calls send exactly once", async () => {
      mockSend.mockResolvedValueOnce({});

      await setDmOptedIn(TABLE_NAME, USER_ID, PRIVATE_CHAT_ID);

      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ConditionalCheckFailedException"));

      await expect(
        setDmOptedIn(TABLE_NAME, USER_ID, PRIVATE_CHAT_ID),
      ).rejects.toThrow("ConditionalCheckFailedException");
    });
  });

  describe("markPrompted", () => {
    it("sends an UpdateItemCommand with correct table and key", async () => {
      mockSend.mockResolvedValueOnce({});

      await markPrompted(TABLE_NAME, USER_ID);

      const { UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(UpdateItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            pk: { S: `DM#${USER_ID}` },
            sk: { S: "STATUS" },
          }),
        }),
      );
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("sets prompted to true in the update expression", async () => {
      mockSend.mockResolvedValueOnce({});

      await markPrompted(TABLE_NAME, USER_ID);

      const { UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(UpdateItemCommand).mock.calls[0][0] as unknown as Record<string, unknown>;
      const updateExpr = call.UpdateExpression as string;

      expect(updateExpr).toContain("prompted");
    });

    it("uses BOOL type for the prompted value", async () => {
      mockSend.mockResolvedValueOnce({});

      await markPrompted(TABLE_NAME, USER_ID);

      const { UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
      const call = vi.mocked(UpdateItemCommand).mock.calls[0][0] as unknown as Record<string, unknown>;
      const exprValues = call.ExpressionAttributeValues as Record<string, { BOOL?: boolean }>;

      // Find the prompted value in expression attribute values
      const promptedValue = Object.values(exprValues).find(
        (v) => v.BOOL !== undefined,
      );
      expect(promptedValue).toBeDefined();
      expect(promptedValue!.BOOL).toBe(true);
    });

    it("calls send exactly once", async () => {
      mockSend.mockResolvedValueOnce({});

      await markPrompted(TABLE_NAME, USER_ID);

      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ConditionalCheckFailedException"));

      await expect(markPrompted(TABLE_NAME, USER_ID)).rejects.toThrow(
        "ConditionalCheckFailedException",
      );
    });
  });
});
