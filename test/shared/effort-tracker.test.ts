import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
}));

vi.mock("@shared/utils/dynamodb-client.js", () => ({
  dynamoDBClient: { send: mockSend },
}));

const TABLE_NAME = "test-effort-table";
const USER_ID = "7890";
const ACTIVITY = "dishes";

describe("effort-tracker service", () => {
  let getEffortEma: typeof import("@shared/services/effort-tracker.js").getEffortEma;
  let updateEffortEma: typeof import("@shared/services/effort-tracker.js").updateEffortEma;
  let GetItemCommand: typeof import("@aws-sdk/client-dynamodb").GetItemCommand;
  let PutItemCommand: typeof import("@aws-sdk/client-dynamodb").PutItemCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.EMA_ALPHA;
    const mod = await import("@shared/services/effort-tracker.js");
    getEffortEma = mod.getEffortEma;
    updateEffortEma = mod.updateEffortEma;
    const dynamodb = await import("@aws-sdk/client-dynamodb");
    GetItemCommand = dynamodb.GetItemCommand;
    PutItemCommand = dynamodb.PutItemCommand;
  });

  afterEach(() => {
    delete process.env.EMA_ALPHA;
  });

  describe("getEffortEma", () => {
    it("sends a GetItemCommand with correct table, pk, and sk", async () => {
      mockSend.mockResolvedValueOnce({ Item: { ema: { N: "2.5" }, sampleCount: { N: "3" } } });

      await getEffortEma(TABLE_NAME, USER_ID, ACTIVITY);

      expect(GetItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            pk: { S: `EFFORT#${USER_ID}` },
            sk: { S: ACTIVITY },
          }),
        }),
      );
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("returns ema and sampleCount when item exists", async () => {
      mockSend.mockResolvedValueOnce({
        Item: { ema: { N: "2.3456" }, sampleCount: { N: "5" } },
      });

      const result = await getEffortEma(TABLE_NAME, USER_ID, ACTIVITY);

      expect(result).toEqual({ ema: 2.3456, sampleCount: 5 });
    });

    it("returns null when item does not exist", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await getEffortEma(TABLE_NAME, USER_ID, ACTIVITY);

      expect(result).toBeNull();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ResourceNotFoundException"));

      await expect(getEffortEma(TABLE_NAME, USER_ID, ACTIVITY)).rejects.toThrow(
        "ResourceNotFoundException",
      );
    });
  });

  describe("updateEffortEma", () => {
    it("cold start — sets ema to effort value when no prior record exists", async () => {
      // GetItem returns no item
      mockSend.mockResolvedValueOnce({});
      // PutItem succeeds
      mockSend.mockResolvedValueOnce({});

      await updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "medium");

      expect(PutItemCommand).toHaveBeenCalledOnce();
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      // medium = 2, cold start sets ema directly
      expect(putInput.Item?.ema).toEqual({ N: "2" });
      expect(putInput.Item?.sampleCount).toEqual({ N: "1" });
    });

    it("cold start — maps low effort to 1", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "low");

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.Item?.ema).toEqual({ N: "1" });
    });

    it("cold start — maps high effort to 3", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "high");

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.Item?.ema).toEqual({ N: "3" });
    });

    it("subsequent update — computes EMA with default alpha 0.3", async () => {
      // GetItem returns existing record
      mockSend.mockResolvedValueOnce({
        Item: { ema: { N: "2" }, sampleCount: { N: "1" }, pk: { S: `EFFORT#${USER_ID}` }, sk: { S: ACTIVITY } },
      });
      mockSend.mockResolvedValueOnce({});

      // Update with high (3), previous EMA was 2, alpha = 0.3
      // EMA_new = 0.3 * 3 + 0.7 * 2 = 0.9 + 1.4 = 2.3
      await updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "high");

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.Item?.ema).toEqual({ N: "2.3" });
      expect(putInput.Item?.sampleCount).toEqual({ N: "2" });
    });

    it("uses EMA_ALPHA from environment variable", async () => {
      process.env.EMA_ALPHA = "0.5";

      // Re-import to pick up new env value
      const mod = await import("@shared/services/effort-tracker.js");

      mockSend.mockResolvedValueOnce({
        Item: { ema: { N: "2" }, sampleCount: { N: "3" }, pk: { S: `EFFORT#${USER_ID}` }, sk: { S: ACTIVITY } },
      });
      mockSend.mockResolvedValueOnce({});

      // EMA_new = 0.5 * 1 + 0.5 * 2 = 0.5 + 1.0 = 1.5
      await mod.updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "low");

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.Item?.ema).toEqual({ N: "1.5" });
    });

    it("rounds EMA to 4 decimal places", async () => {
      mockSend.mockResolvedValueOnce({
        Item: { ema: { N: "1.5" }, sampleCount: { N: "2" }, pk: { S: `EFFORT#${USER_ID}` }, sk: { S: ACTIVITY } },
      });
      mockSend.mockResolvedValueOnce({});

      // EMA_new = 0.3 * 3 + 0.7 * 1.5 = 0.9 + 1.05 = 1.95 (already 4 decimals)
      // Try a value that produces longer decimals:
      // With ema=1.3333, effort=high(3): 0.3*3 + 0.7*1.3333 = 0.9 + 0.93331 = 1.83331 → 1.8333
      mockSend.mockReset();
      mockSend.mockResolvedValueOnce({
        Item: { ema: { N: "1.3333" }, sampleCount: { N: "5" }, pk: { S: `EFFORT#${USER_ID}` }, sk: { S: ACTIVITY } },
      });
      mockSend.mockResolvedValueOnce({});

      await updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "high");

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      // 0.3 * 3 + 0.7 * 1.3333 = 0.9 + 0.93331 = 1.83331 → rounded to 1.8333
      expect(putInput.Item?.ema).toEqual({ N: "1.8333" });
    });

    it("uses correct PK and SK in PutItemCommand", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "medium");

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.TableName).toBe(TABLE_NAME);
      expect(putInput.Item?.pk).toEqual({ S: `EFFORT#${USER_ID}` });
      expect(putInput.Item?.sk).toEqual({ S: ACTIVITY });
    });

    it("uses optimistic locking with attribute_not_exists for new items", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "low");

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.ConditionExpression).toContain("attribute_not_exists");
    });

    it("uses optimistic locking with sampleCount condition for existing items", async () => {
      mockSend.mockResolvedValueOnce({
        Item: { ema: { N: "2" }, sampleCount: { N: "3" }, pk: { S: `EFFORT#${USER_ID}` }, sk: { S: ACTIVITY } },
      });
      mockSend.mockResolvedValueOnce({});

      await updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "high");

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.ConditionExpression).toContain("sampleCount = :expected");
    });

    it("handles ConditionalCheckFailedException gracefully without throwing", async () => {
      mockSend.mockResolvedValueOnce({});
      // PutItem fails with conditional check
      const error = new Error("ConditionalCheckFailedException");
      error.name = "ConditionalCheckFailedException";
      mockSend.mockRejectedValueOnce(error);

      // Should not throw
      await expect(
        updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "medium"),
      ).resolves.not.toThrow();
    });

    it("calls send twice — once for GetItem, once for PutItem", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updateEffortEma(TABLE_NAME, USER_ID, ACTIVITY, "medium");

      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });
});
