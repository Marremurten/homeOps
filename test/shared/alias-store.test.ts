import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  QueryCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "QueryCommand", input };
  }),
  PutItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "PutItemCommand", input };
  }),
  UpdateItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "UpdateItemCommand", input };
  }),
  DeleteItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "DeleteItemCommand", input };
  }),
}));

vi.mock("@shared/utils/dynamodb-client.js", () => ({
  dynamoDBClient: { send: mockSend },
}));

const TABLE_NAME = "HomeOps-Aliases";
const CHAT_ID = "-100123456";

describe("alias-store", () => {
  let getAliasesForChat: typeof import("@shared/services/alias-store.js").getAliasesForChat;
  let putAlias: typeof import("@shared/services/alias-store.js").putAlias;
  let incrementConfirmation: typeof import("@shared/services/alias-store.js").incrementConfirmation;
  let deleteAlias: typeof import("@shared/services/alias-store.js").deleteAlias;
  let QueryCommand: typeof import("@aws-sdk/client-dynamodb").QueryCommand;
  let PutItemCommand: typeof import("@aws-sdk/client-dynamodb").PutItemCommand;
  let UpdateItemCommand: typeof import("@aws-sdk/client-dynamodb").UpdateItemCommand;
  let DeleteItemCommand: typeof import("@aws-sdk/client-dynamodb").DeleteItemCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@shared/services/alias-store.js");
    getAliasesForChat = mod.getAliasesForChat;
    putAlias = mod.putAlias;
    incrementConfirmation = mod.incrementConfirmation;
    deleteAlias = mod.deleteAlias;

    const dynamodb = await import("@aws-sdk/client-dynamodb");
    QueryCommand = dynamodb.QueryCommand;
    PutItemCommand = dynamodb.PutItemCommand;
    UpdateItemCommand = dynamodb.UpdateItemCommand;
    DeleteItemCommand = dynamodb.DeleteItemCommand;
  });

  describe("getAliasesForChat", () => {
    it("sends a QueryCommand with PK ALIAS#<chatId>", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await getAliasesForChat(TABLE_NAME, CHAT_ID);

      expect(QueryCommand).toHaveBeenCalledOnce();
      const queryInput = vi.mocked(QueryCommand).mock.calls[0][0];
      expect(queryInput.TableName).toBe(TABLE_NAME);

      // The PK should be ALIAS#<chatId>
      const exprValues = queryInput.ExpressionAttributeValues as Record<string, { S?: string }>;
      const pkValue = Object.values(exprValues).find((v) => v.S?.startsWith("ALIAS#"));
      expect(pkValue).toBeDefined();
      expect(pkValue!.S).toBe(`ALIAS#${CHAT_ID}`);
    });

    it("returns an empty array when no items exist", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      const result = await getAliasesForChat(TABLE_NAME, CHAT_ID);

      expect(result).toEqual([]);
    });

    it("returns an empty array when Items is undefined", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await getAliasesForChat(TABLE_NAME, CHAT_ID);

      expect(result).toEqual([]);
    });

    it("maps DynamoDB items to alias objects with correct fields", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            PK: { S: `ALIAS#${CHAT_ID}` },
            SK: { S: "disk" },
            canonicalActivity: { S: "diskning" },
            confirmations: { N: "3" },
            source: { S: "seed" },
          },
        ],
      });

      const result = await getAliasesForChat(TABLE_NAME, CHAT_ID);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        alias: "disk",
        canonicalActivity: "diskning",
        confirmations: 3,
        source: "seed",
      });
    });

    it("returns multiple aliases when DynamoDB returns multiple items", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            PK: { S: `ALIAS#${CHAT_ID}` },
            SK: { S: "disk" },
            canonicalActivity: { S: "diskning" },
            confirmations: { N: "5" },
            source: { S: "seed" },
          },
          {
            PK: { S: `ALIAS#${CHAT_ID}` },
            SK: { S: "sopor" },
            canonicalActivity: { S: "sophantering" },
            confirmations: { N: "1" },
            source: { S: "learned" },
          },
        ],
      });

      const result = await getAliasesForChat(TABLE_NAME, CHAT_ID);

      expect(result).toHaveLength(2);
      expect(result[0].alias).toBe("disk");
      expect(result[1].alias).toBe("sopor");
      expect(result[1].source).toBe("learned");
    });

    it("calls send exactly once per invocation", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await getAliasesForChat(TABLE_NAME, CHAT_ID);

      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ResourceNotFoundException"));

      await expect(getAliasesForChat(TABLE_NAME, CHAT_ID)).rejects.toThrow(
        "ResourceNotFoundException",
      );
    });
  });

  describe("putAlias", () => {
    const ALIAS_PARAMS = {
      tableName: TABLE_NAME,
      chatId: CHAT_ID,
      alias: "sopor",
      canonicalActivity: "sophantering",
      source: "learned" as const,
    };

    it("sends a PutItemCommand with correct table name", async () => {
      mockSend.mockResolvedValueOnce({});

      await putAlias(ALIAS_PARAMS);

      expect(PutItemCommand).toHaveBeenCalledOnce();
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.TableName).toBe(TABLE_NAME);
    });

    it("sets PK to ALIAS#<chatId>", async () => {
      mockSend.mockResolvedValueOnce({});

      await putAlias(ALIAS_PARAMS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.Item?.PK).toEqual({ S: `ALIAS#${CHAT_ID}` });
    });

    it("sets SK to the alias string", async () => {
      mockSend.mockResolvedValueOnce({});

      await putAlias(ALIAS_PARAMS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.Item?.SK).toEqual({ S: "sopor" });
    });

    it("includes canonicalActivity and source attributes", async () => {
      mockSend.mockResolvedValueOnce({});

      await putAlias(ALIAS_PARAMS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.Item?.canonicalActivity).toEqual({ S: "sophantering" });
      expect(putInput.Item?.source).toEqual({ S: "learned" });
    });

    it("sets GSI1PK and GSI1SK for the global secondary index", async () => {
      mockSend.mockResolvedValueOnce({});

      await putAlias(ALIAS_PARAMS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      // GSI1 attributes should be present for the alias lookup pattern
      expect(putInput.Item).toHaveProperty("GSI1PK");
      expect(putInput.Item).toHaveProperty("GSI1SK");
    });

    it("initializes confirmations to 0 for new aliases", async () => {
      mockSend.mockResolvedValueOnce({});

      await putAlias(ALIAS_PARAMS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.Item?.confirmations).toEqual({ N: "0" });
    });

    it("calls send exactly once", async () => {
      mockSend.mockResolvedValueOnce({});

      await putAlias(ALIAS_PARAMS);

      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ConditionalCheckFailedException"));

      await expect(putAlias(ALIAS_PARAMS)).rejects.toThrow(
        "ConditionalCheckFailedException",
      );
    });
  });

  describe("incrementConfirmation", () => {
    it("sends an UpdateItemCommand with correct table and key", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementConfirmation(TABLE_NAME, CHAT_ID, "disk");

      expect(UpdateItemCommand).toHaveBeenCalledOnce();
      const updateInput = vi.mocked(UpdateItemCommand).mock.calls[0][0];
      expect(updateInput.TableName).toBe(TABLE_NAME);
      expect(updateInput.Key?.PK).toEqual({ S: `ALIAS#${CHAT_ID}` });
      expect(updateInput.Key?.SK).toEqual({ S: "disk" });
    });

    it("uses ADD confirmations :inc in the update expression", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementConfirmation(TABLE_NAME, CHAT_ID, "disk");

      const updateInput = vi.mocked(UpdateItemCommand).mock.calls[0][0] as unknown as Record<string, unknown>;
      const updateExpr = updateInput.UpdateExpression as string;
      expect(updateExpr).toContain("ADD");
      expect(updateExpr).toMatch(/confirmations\s+:inc/);
    });

    it("sets :inc expression attribute value to 1", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementConfirmation(TABLE_NAME, CHAT_ID, "disk");

      const updateInput = vi.mocked(UpdateItemCommand).mock.calls[0][0] as unknown as Record<string, unknown>;
      const exprValues = updateInput.ExpressionAttributeValues as Record<string, { N?: string }>;
      expect(exprValues[":inc"]).toBeDefined();
      expect(exprValues[":inc"].N).toBe("1");
    });

    it("calls send exactly once", async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementConfirmation(TABLE_NAME, CHAT_ID, "disk");

      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ValidationException"));

      await expect(incrementConfirmation(TABLE_NAME, CHAT_ID, "disk")).rejects.toThrow(
        "ValidationException",
      );
    });
  });

  describe("deleteAlias", () => {
    it("sends a DeleteItemCommand with correct table and key", async () => {
      mockSend.mockResolvedValueOnce({});

      await deleteAlias(TABLE_NAME, CHAT_ID, "sopor");

      expect(DeleteItemCommand).toHaveBeenCalledOnce();
      const deleteInput = vi.mocked(DeleteItemCommand).mock.calls[0][0];
      expect(deleteInput.TableName).toBe(TABLE_NAME);
      expect(deleteInput.Key?.PK).toEqual({ S: `ALIAS#${CHAT_ID}` });
      expect(deleteInput.Key?.SK).toEqual({ S: "sopor" });
    });

    it("calls send exactly once", async () => {
      mockSend.mockResolvedValueOnce({});

      await deleteAlias(TABLE_NAME, CHAT_ID, "sopor");

      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ResourceNotFoundException"));

      await expect(deleteAlias(TABLE_NAME, CHAT_ID, "sopor")).rejects.toThrow(
        "ResourceNotFoundException",
      );
    });
  });
});
