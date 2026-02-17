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

const TABLE_NAME = "HomeOps-Preferences";
const USER_ID = "12345";
const ALPHA = 0.2;

describe("preference-tracker", () => {
  let updateIgnoreRate: typeof import("@shared/services/preference-tracker.js").updateIgnoreRate;
  let getIgnoreRate: typeof import("@shared/services/preference-tracker.js").getIgnoreRate;
  let updateInteractionFrequency: typeof import("@shared/services/preference-tracker.js").updateInteractionFrequency;
  let getInteractionFrequency: typeof import("@shared/services/preference-tracker.js").getInteractionFrequency;
  let GetItemCommand: typeof import("@aws-sdk/client-dynamodb").GetItemCommand;
  let PutItemCommand: typeof import("@aws-sdk/client-dynamodb").PutItemCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.EMA_ALPHA_IGNORE = "0.2";
    const mod = await import("@shared/services/preference-tracker.js");
    updateIgnoreRate = mod.updateIgnoreRate;
    getIgnoreRate = mod.getIgnoreRate;
    updateInteractionFrequency = mod.updateInteractionFrequency;
    getInteractionFrequency = mod.getInteractionFrequency;
    const dynamodb = await import("@aws-sdk/client-dynamodb");
    GetItemCommand = dynamodb.GetItemCommand;
    PutItemCommand = dynamodb.PutItemCommand;
  });

  afterEach(() => {
    delete process.env.EMA_ALPHA_IGNORE;
  });

  describe("updateIgnoreRate", () => {
    it("cold start: sets rate to 1.0 when first value is ignored=true", async () => {
      // GetItem returns no existing item (cold start)
      mockSend.mockResolvedValueOnce({});
      // PutItem succeeds
      mockSend.mockResolvedValueOnce({});

      await updateIgnoreRate(TABLE_NAME, USER_ID, true);

      expect(PutItemCommand).toHaveBeenCalledOnce();
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.rate.N)).toBe(1);
      expect(Number(item.sampleCount.N)).toBe(1);
    });

    it("cold start: sets rate to 0.0 when first value is ignored=false", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updateIgnoreRate(TABLE_NAME, USER_ID, false);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.rate.N)).toBe(0);
      expect(Number(item.sampleCount.N)).toBe(1);
    });

    it("computes EMA correctly for ignored=true on existing rate", async () => {
      // Existing rate: 0.5, sampleCount: 3
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "ignoreRate" },
          rate: { N: "0.5" },
          sampleCount: { N: "3" },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await updateIgnoreRate(TABLE_NAME, USER_ID, true);

      // EMA: alpha * newValue + (1 - alpha) * oldRate
      // 0.2 * 1 + 0.8 * 0.5 = 0.2 + 0.4 = 0.6
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.rate.N)).toBe(0.6);
      expect(Number(item.sampleCount.N)).toBe(4);
    });

    it("computes EMA correctly for ignored=false on existing rate", async () => {
      // Existing rate: 0.5, sampleCount: 3
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "ignoreRate" },
          rate: { N: "0.5" },
          sampleCount: { N: "3" },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await updateIgnoreRate(TABLE_NAME, USER_ID, false);

      // EMA: 0.2 * 0 + 0.8 * 0.5 = 0 + 0.4 = 0.4
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.rate.N)).toBe(0.4);
      expect(Number(item.sampleCount.N)).toBe(4);
    });

    it("rounds rate to 4 decimal places", async () => {
      // Existing rate: 0.3333, sampleCount: 5
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "ignoreRate" },
          rate: { N: "0.3333" },
          sampleCount: { N: "5" },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await updateIgnoreRate(TABLE_NAME, USER_ID, true);

      // EMA: 0.2 * 1 + 0.8 * 0.3333 = 0.2 + 0.26664 = 0.46664 -> rounds to 0.4666
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.rate.N)).toBe(0.4666);
    });

    it("uses PK PREF#<userId> and SK ignoreRate", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updateIgnoreRate(TABLE_NAME, USER_ID, true);

      // Check GetItemCommand uses correct key
      expect(GetItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            pk: { S: `PREF#${USER_ID}` },
            sk: { S: "ignoreRate" },
          }),
        }),
      );

      // Check PutItemCommand uses correct key
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(item.pk).toEqual({ S: `PREF#${USER_ID}` });
      expect(item.sk).toEqual({ S: "ignoreRate" });
    });

    it("uses optimistic locking on sampleCount for existing items", async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "ignoreRate" },
          rate: { N: "0.5" },
          sampleCount: { N: "3" },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await updateIgnoreRate(TABLE_NAME, USER_ID, true);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      // Optimistic locking: ConditionExpression should check sampleCount matches expected value
      expect(putInput).toHaveProperty("ConditionExpression");
      const condExpr = putInput.ConditionExpression as string;
      expect(condExpr).toContain("sampleCount");
    });

    it("does not use condition expression on cold start (new item)", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updateIgnoreRate(TABLE_NAME, USER_ID, false);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      // For new items, condition should check attribute_not_exists OR no condition
      // Either no ConditionExpression, or one that checks the item doesn't exist
      const condExpr = putInput.ConditionExpression as string | undefined;
      if (condExpr) {
        expect(condExpr).toContain("attribute_not_exists");
      }
    });

    it("reads alpha from EMA_ALPHA_IGNORE env var", async () => {
      process.env.EMA_ALPHA_IGNORE = "0.5";

      // Re-import to pick up new env value (if module caches it)
      const mod = await import("@shared/services/preference-tracker.js");

      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "ignoreRate" },
          rate: { N: "0.4" },
          sampleCount: { N: "2" },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await mod.updateIgnoreRate(TABLE_NAME, USER_ID, true);

      // EMA with alpha=0.5: 0.5 * 1 + 0.5 * 0.4 = 0.5 + 0.2 = 0.7
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.rate.N)).toBe(0.7);
    });

    it("defaults alpha to 0.2 when EMA_ALPHA_IGNORE is not set", async () => {
      delete process.env.EMA_ALPHA_IGNORE;

      const mod = await import("@shared/services/preference-tracker.js");

      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "ignoreRate" },
          rate: { N: "0.5" },
          sampleCount: { N: "3" },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await mod.updateIgnoreRate(TABLE_NAME, USER_ID, true);

      // EMA with alpha=0.2: 0.2 * 1 + 0.8 * 0.5 = 0.6
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.rate.N)).toBe(0.6);
    });

    it("throws when DynamoDB put fails", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockRejectedValueOnce(new Error("ConditionalCheckFailedException"));

      await expect(updateIgnoreRate(TABLE_NAME, USER_ID, true)).rejects.toThrow(
        "ConditionalCheckFailedException",
      );
    });
  });

  describe("getIgnoreRate", () => {
    it("returns rate and sampleCount when item exists", async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "ignoreRate" },
          rate: { N: "0.75" },
          sampleCount: { N: "10" },
        },
      });

      const result = await getIgnoreRate(TABLE_NAME, USER_ID);

      expect(result).toEqual({ rate: 0.75, sampleCount: 10 });
    });

    it("returns null when item does not exist", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await getIgnoreRate(TABLE_NAME, USER_ID);

      expect(result).toBeNull();
    });

    it("sends GetItemCommand with correct PK and SK", async () => {
      mockSend.mockResolvedValueOnce({});

      await getIgnoreRate(TABLE_NAME, USER_ID);

      expect(GetItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            pk: { S: `PREF#${USER_ID}` },
            sk: { S: "ignoreRate" },
          }),
        }),
      );
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ResourceNotFoundException"));

      await expect(getIgnoreRate(TABLE_NAME, USER_ID)).rejects.toThrow(
        "ResourceNotFoundException",
      );
    });
  });

  describe("updateInteractionFrequency", () => {
    it("cold start: sets frequency to messageCount on first call", async () => {
      // GetItem returns no existing item
      mockSend.mockResolvedValueOnce({});
      // PutItem succeeds
      mockSend.mockResolvedValueOnce({});

      await updateInteractionFrequency(TABLE_NAME, USER_ID, 5);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.frequency.N)).toBe(5);
      expect(Number(item.sampleCount.N)).toBe(1);
    });

    it("computes EMA on messageCount for existing frequency", async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "interactionFrequency" },
          frequency: { N: "10" },
          sampleCount: { N: "4" },
          lastDate: { S: "2026-02-16" },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await updateInteractionFrequency(TABLE_NAME, USER_ID, 8);

      // EMA: 0.2 * 8 + 0.8 * 10 = 1.6 + 8 = 9.6
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.frequency.N)).toBe(9.6);
      expect(Number(item.sampleCount.N)).toBe(5);
    });

    it("rounds frequency to 4 decimal places", async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "interactionFrequency" },
          frequency: { N: "3.3333" },
          sampleCount: { N: "2" },
          lastDate: { S: "2026-02-16" },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await updateInteractionFrequency(TABLE_NAME, USER_ID, 7);

      // EMA: 0.2 * 7 + 0.8 * 3.3333 = 1.4 + 2.66664 = 4.06664 -> rounds to 4.0666
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.frequency.N)).toBe(4.0666);
    });

    it("uses PK PREF#<userId> and SK interactionFrequency", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updateInteractionFrequency(TABLE_NAME, USER_ID, 3);

      expect(GetItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            pk: { S: `PREF#${USER_ID}` },
            sk: { S: "interactionFrequency" },
          }),
        }),
      );

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(item.pk).toEqual({ S: `PREF#${USER_ID}` });
      expect(item.sk).toEqual({ S: "interactionFrequency" });
    });

    it("includes lastDate field as Stockholm date string", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updateInteractionFrequency(TABLE_NAME, USER_ID, 3);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(item.lastDate).toBeDefined();
      expect(item.lastDate.S).toBeDefined();
      // Should be a date string in YYYY-MM-DD format
      expect(item.lastDate.S).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("uses optimistic locking on sampleCount for existing items", async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "interactionFrequency" },
          frequency: { N: "5" },
          sampleCount: { N: "2" },
          lastDate: { S: "2026-02-16" },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await updateInteractionFrequency(TABLE_NAME, USER_ID, 4);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      expect(putInput).toHaveProperty("ConditionExpression");
      const condExpr = putInput.ConditionExpression as string;
      expect(condExpr).toContain("sampleCount");
    });

    it("throws when DynamoDB put fails", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockRejectedValueOnce(new Error("ConditionalCheckFailedException"));

      await expect(
        updateInteractionFrequency(TABLE_NAME, USER_ID, 5),
      ).rejects.toThrow("ConditionalCheckFailedException");
    });

    it("uses alpha from EMA_ALPHA_IGNORE env var", async () => {
      process.env.EMA_ALPHA_IGNORE = "0.3";

      const mod = await import("@shared/services/preference-tracker.js");

      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "interactionFrequency" },
          frequency: { N: "10" },
          sampleCount: { N: "3" },
          lastDate: { S: "2026-02-16" },
        },
      });
      mockSend.mockResolvedValueOnce({});

      await mod.updateInteractionFrequency(TABLE_NAME, USER_ID, 4);

      // EMA with alpha=0.3: 0.3 * 4 + 0.7 * 10 = 1.2 + 7 = 8.2
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0] as Record<string, unknown>;
      const item = putInput.Item as Record<string, { S?: string; N?: string }>;
      expect(Number(item.frequency.N)).toBe(8.2);
    });
  });

  describe("getInteractionFrequency", () => {
    it("returns frequency and sampleCount when item exists", async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: { S: `PREF#${USER_ID}` },
          sk: { S: "interactionFrequency" },
          frequency: { N: "7.5" },
          sampleCount: { N: "6" },
          lastDate: { S: "2026-02-17" },
        },
      });

      const result = await getInteractionFrequency(TABLE_NAME, USER_ID);

      expect(result).toEqual({ frequency: 7.5, sampleCount: 6 });
    });

    it("returns null when item does not exist", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await getInteractionFrequency(TABLE_NAME, USER_ID);

      expect(result).toBeNull();
    });

    it("sends GetItemCommand with correct PK and SK", async () => {
      mockSend.mockResolvedValueOnce({});

      await getInteractionFrequency(TABLE_NAME, USER_ID);

      expect(GetItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            pk: { S: `PREF#${USER_ID}` },
            sk: { S: "interactionFrequency" },
          }),
        }),
      );
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ResourceNotFoundException"));

      await expect(getInteractionFrequency(TABLE_NAME, USER_ID)).rejects.toThrow(
        "ResourceNotFoundException",
      );
    });
  });
});
