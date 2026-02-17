import { describe, it, expect, vi, beforeEach } from "vitest";

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

const TABLE_NAME = "test-pattern-table";
const CHAT_ID = "-100123456";
const USER_ID = "7890";
const ACTIVITY = "dishes";

// 2026-02-17 is a Tuesday. 12:00 UTC = 13:00 Stockholm (CET, UTC+1)
const TUESDAY_NOON_UTC = 1739793600; // 2026-02-17T12:00:00Z (unix seconds)
// Convert to ISO for verification: new Date(1739793600 * 1000).toISOString() = "2025-02-17T12:00:00.000Z"
// Actually, let me use a known date string instead for clarity.
// 2026-02-17T12:00:00Z — Tuesday, 13:00 Stockholm time (CET, UTC+1)
const TUESDAY_NOON_ISO = "2026-02-17T12:00:00.000Z";
const TUESDAY_NOON_EPOCH_MS = new Date(TUESDAY_NOON_ISO).getTime();

// 2026-02-21T22:30:00Z — Saturday, 23:30 Stockholm time (CET, UTC+1)
const SATURDAY_LATE_ISO = "2026-02-21T22:30:00.000Z";
const SATURDAY_LATE_EPOCH_MS = new Date(SATURDAY_LATE_ISO).getTime();

function makeEmptyPatternItem() {
  return {
    pk: { S: `PATTERN#${CHAT_ID}#${USER_ID}` },
    sk: { S: ACTIVITY },
    totalCount: { N: "0" },
    lastSeen: { S: "" },
    mon: { N: "0" },
    tue: { N: "0" },
    wed: { N: "0" },
    thu: { N: "0" },
    fri: { N: "0" },
    sat: { N: "0" },
    sun: { N: "0" },
    "0": { N: "0" }, "1": { N: "0" }, "2": { N: "0" }, "3": { N: "0" },
    "4": { N: "0" }, "5": { N: "0" }, "6": { N: "0" }, "7": { N: "0" },
    "8": { N: "0" }, "9": { N: "0" }, "10": { N: "0" }, "11": { N: "0" },
    "12": { N: "0" }, "13": { N: "0" }, "14": { N: "0" }, "15": { N: "0" },
    "16": { N: "0" }, "17": { N: "0" }, "18": { N: "0" }, "19": { N: "0" },
    "20": { N: "0" }, "21": { N: "0" }, "22": { N: "0" }, "23": { N: "0" },
  };
}

describe("pattern-tracker service", () => {
  let updatePatternHabit: typeof import("@shared/services/pattern-tracker.js").updatePatternHabit;
  let getPatternHabit: typeof import("@shared/services/pattern-tracker.js").getPatternHabit;
  let GetItemCommand: typeof import("@aws-sdk/client-dynamodb").GetItemCommand;
  let PutItemCommand: typeof import("@aws-sdk/client-dynamodb").PutItemCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@shared/services/pattern-tracker.js");
    updatePatternHabit = mod.updatePatternHabit;
    getPatternHabit = mod.getPatternHabit;
    const dynamodb = await import("@aws-sdk/client-dynamodb");
    GetItemCommand = dynamodb.GetItemCommand;
    PutItemCommand = dynamodb.PutItemCommand;
  });

  describe("getPatternHabit", () => {
    it("sends a GetItemCommand with correct table, pk, and sk", async () => {
      mockSend.mockResolvedValueOnce({ Item: makeEmptyPatternItem() });

      await getPatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY);

      expect(GetItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: TABLE_NAME,
          Key: expect.objectContaining({
            pk: { S: `PATTERN#${CHAT_ID}#${USER_ID}` },
            sk: { S: ACTIVITY },
          }),
        }),
      );
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it("returns the record when item exists", async () => {
      const item = makeEmptyPatternItem();
      item.totalCount = { N: "5" };
      item.tue = { N: "3" };
      item["13"] = { N: "2" };
      item.lastSeen = { S: "2026-02-17T13:00:00.000Z" };
      mockSend.mockResolvedValueOnce({ Item: item });

      const result = await getPatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY);

      expect(result).not.toBeNull();
    });

    it("returns null when item does not exist", async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await getPatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY);

      expect(result).toBeNull();
    });

    it("throws when DynamoDB returns an error", async () => {
      mockSend.mockRejectedValueOnce(new Error("ResourceNotFoundException"));

      await expect(
        getPatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY),
      ).rejects.toThrow("ResourceNotFoundException");
    });
  });

  describe("updatePatternHabit", () => {
    it("creates a new item when no prior record exists", async () => {
      // GetItem returns no item
      mockSend.mockResolvedValueOnce({});
      // PutItem succeeds
      mockSend.mockResolvedValueOnce({});

      // Tuesday 13:00 Stockholm
      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, TUESDAY_NOON_EPOCH_MS);

      expect(PutItemCommand).toHaveBeenCalledOnce();
      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.TableName).toBe(TABLE_NAME);
      expect(putInput.Item?.pk).toEqual({ S: `PATTERN#${CHAT_ID}#${USER_ID}` });
      expect(putInput.Item?.sk).toEqual({ S: ACTIVITY });
    });

    it("initializes all day counters to 0 and sets relevant day to 1 for new items", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      // Tuesday 13:00 Stockholm
      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, TUESDAY_NOON_EPOCH_MS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      const item = putInput.Item!;

      // Tuesday should be 1, all others should be 0
      expect(item.tue).toEqual({ N: "1" });
      expect(item.mon).toEqual({ N: "0" });
      expect(item.wed).toEqual({ N: "0" });
      expect(item.thu).toEqual({ N: "0" });
      expect(item.fri).toEqual({ N: "0" });
      expect(item.sat).toEqual({ N: "0" });
      expect(item.sun).toEqual({ N: "0" });
    });

    it("initializes all hour counters to 0 and sets relevant hour to 1 for new items", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      // Tuesday 12:00 UTC = 13:00 Stockholm
      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, TUESDAY_NOON_EPOCH_MS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      const item = putInput.Item!;

      // Hour 13 in Stockholm should be 1
      expect(item["13"]).toEqual({ N: "1" });
      // Other hours should be 0
      expect(item["0"]).toEqual({ N: "0" });
      expect(item["12"]).toEqual({ N: "0" });
      expect(item["14"]).toEqual({ N: "0" });
      expect(item["23"]).toEqual({ N: "0" });
    });

    it("sets totalCount to 1 for new items", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, TUESDAY_NOON_EPOCH_MS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.Item?.totalCount).toEqual({ N: "1" });
    });

    it("sets lastSeen to ISO 8601 string", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, TUESDAY_NOON_EPOCH_MS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      const lastSeen = putInput.Item?.lastSeen?.S;
      expect(lastSeen).toBeDefined();
      // Should be a valid ISO 8601 string
      expect(new Date(lastSeen!).toISOString()).toBe(lastSeen);
    });

    it("increments existing day and hour counters for existing items", async () => {
      const existingItem = makeEmptyPatternItem();
      existingItem.totalCount = { N: "5" };
      existingItem.tue = { N: "2" };
      existingItem["13"] = { N: "3" };
      existingItem.lastSeen = { S: "2026-02-16T10:00:00.000Z" };

      // GetItem returns existing record
      mockSend.mockResolvedValueOnce({ Item: existingItem });
      // PutItem succeeds
      mockSend.mockResolvedValueOnce({});

      // Tuesday 13:00 Stockholm
      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, TUESDAY_NOON_EPOCH_MS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      const item = putInput.Item!;

      // tue should be incremented from 2 to 3
      expect(item.tue).toEqual({ N: "3" });
      // hour 13 should be incremented from 3 to 4
      expect(item["13"]).toEqual({ N: "4" });
      // totalCount should be incremented from 5 to 6
      expect(item.totalCount).toEqual({ N: "6" });
    });

    it("uses correct day key for Saturday", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      // Saturday 23:30 Stockholm
      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, SATURDAY_LATE_EPOCH_MS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      expect(putInput.Item?.sat).toEqual({ N: "1" });
    });

    it("uses Stockholm timezone for hour extraction", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      // 2026-02-21T22:30:00Z = 23:30 Stockholm (CET, UTC+1), Saturday
      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, SATURDAY_LATE_EPOCH_MS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      // Hour should be 23 in Stockholm time, not 22 (UTC)
      expect(putInput.Item?.["23"]).toEqual({ N: "1" });
      expect(putInput.Item?.["22"]).toEqual({ N: "0" });
    });

    it("updates lastSeen to new timestamp", async () => {
      const existingItem = makeEmptyPatternItem();
      existingItem.totalCount = { N: "1" };
      existingItem.lastSeen = { S: "2026-02-16T10:00:00.000Z" };

      mockSend.mockResolvedValueOnce({ Item: existingItem });
      mockSend.mockResolvedValueOnce({});

      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, TUESDAY_NOON_EPOCH_MS);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      const lastSeen = putInput.Item?.lastSeen?.S;
      // lastSeen should be updated, not remain as the old value
      expect(lastSeen).not.toBe("2026-02-16T10:00:00.000Z");
    });

    it("calls send twice — once for GetItem, once for PutItem", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, TUESDAY_NOON_EPOCH_MS);

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("throws when DynamoDB returns an unexpected error", async () => {
      mockSend.mockRejectedValueOnce(new Error("InternalServerError"));

      await expect(
        updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, TUESDAY_NOON_EPOCH_MS),
      ).rejects.toThrow("InternalServerError");
    });

    it("handles summer time correctly — hour offset changes to UTC+2", async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({});

      // 2026-07-15T14:00:00Z = 16:00 Stockholm (CEST, UTC+2), Wednesday
      const summerTimestamp = new Date("2026-07-15T14:00:00.000Z").getTime();
      await updatePatternHabit(TABLE_NAME, CHAT_ID, USER_ID, ACTIVITY, summerTimestamp);

      const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
      // Hour should be 16 in Stockholm (CEST), not 14 (UTC)
      expect(putInput.Item?.["16"]).toEqual({ N: "1" });
      expect(putInput.Item?.["14"]).toEqual({ N: "0" });
      // Wednesday
      expect(putInput.Item?.wed).toEqual({ N: "1" });
    });
  });
});
