import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClassificationResult } from "@shared/types/classification.js";

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(function () {
    return { send: mockSend };
  }),
  PutItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { _type: "PutItemCommand", input };
  }),
}));

const { mockUlid } = vi.hoisted(() => ({
  mockUlid: vi.fn().mockReturnValue("01HQTESTULID000000000000"),
}));

vi.mock("ulidx", () => ({
  ulid: mockUlid,
}));

const FAKE_CLASSIFICATION: ClassificationResult = {
  type: "chore",
  activity: "dishes",
  effort: "medium",
  confidence: 0.92,
};

const BASE_PARAMS = {
  tableName: "HomeOps-Activities",
  chatId: "-100123456",
  messageId: 42,
  userId: 7890,
  userName: "alice",
  classification: FAKE_CLASSIFICATION,
  timestamp: 1700000000,
};

describe("saveActivity", () => {
  let saveActivity: typeof import("@shared/services/activity-store.js").saveActivity;
  let PutItemCommand: typeof import("@aws-sdk/client-dynamodb").PutItemCommand;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@shared/services/activity-store.js");
    saveActivity = mod.saveActivity;
    const dynamodb = await import("@aws-sdk/client-dynamodb");
    PutItemCommand = dynamodb.PutItemCommand;
  });

  it("sends a PutItemCommand with the correct table name", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveActivity(BASE_PARAMS);

    expect(PutItemCommand).toHaveBeenCalledOnce();
    const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
    expect(putInput.TableName).toBe("HomeOps-Activities");
  });

  it("uses chatId as partition key and activityId as sort key", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveActivity(BASE_PARAMS);

    const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
    expect(putInput.Item?.chatId).toEqual({ S: "-100123456" });
    expect(putInput.Item?.activityId).toEqual({ S: "01HQTESTULID000000000000" });
  });

  it("returns the generated activityId", async () => {
    mockSend.mockResolvedValueOnce({});

    const result = await saveActivity(BASE_PARAMS);

    expect(result).toBe("01HQTESTULID000000000000");
  });

  it("seeds the ULID with the message timestamp, not current time", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveActivity({ ...BASE_PARAMS, timestamp: 1700000000 });

    // ulid(seedTime) — the timestamp should be passed as the seed
    expect(mockUlid).toHaveBeenCalledWith(1700000000);
  });

  it("includes all required DynamoDB attributes with correct types", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveActivity(BASE_PARAMS);

    const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
    const item = putInput.Item!;

    // String attributes (S)
    expect(item.chatId).toEqual({ S: "-100123456" });
    expect(item.activityId).toEqual({ S: "01HQTESTULID000000000000" });
    expect(item.userName).toEqual({ S: "alice" });
    expect(item.type).toEqual({ S: "chore" });
    expect(item.activity).toEqual({ S: "dishes" });
    expect(item.effort).toEqual({ S: "medium" });

    // Number attributes (N) — DynamoDB stores numbers as strings in the N type
    expect(item.messageId).toEqual({ N: "42" });
    expect(item.userId).toEqual({ N: "7890" });
    expect(item.confidence).toEqual({ N: "0.92" });
    expect(item.timestamp).toEqual({ N: "1700000000" });

    // createdAt is an ISO string (S)
    expect(item.createdAt).toHaveProperty("S");
    expect(typeof item.createdAt.S).toBe("string");
  });

  it("includes botMessageId when provided", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveActivity({ ...BASE_PARAMS, botMessageId: 55 });

    const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
    expect(putInput.Item?.botMessageId).toEqual({ N: "55" });
  });

  it("omits botMessageId when not provided", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveActivity(BASE_PARAMS);

    const putInput = vi.mocked(PutItemCommand).mock.calls[0][0];
    expect(putInput.Item).not.toHaveProperty("botMessageId");
  });

  it("throws when DynamoDB returns an error", async () => {
    mockSend.mockRejectedValueOnce(new Error("ConditionalCheckFailedException"));

    await expect(saveActivity(BASE_PARAMS)).rejects.toThrow(
      "ConditionalCheckFailedException"
    );
  });

  it("calls send exactly once per invocation", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveActivity(BASE_PARAMS);

    expect(mockSend).toHaveBeenCalledOnce();
  });
});
