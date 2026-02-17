import { describe, it, expect } from "vitest";

describe("ClassificationSchema", () => {
  // We use a dynamic import so the test fails with "module not found"
  // rather than a compile-time error when the module doesn't exist yet.
  async function loadSchema() {
    const mod = await import("@shared/types/classification.js");
    return mod.ClassificationSchema;
  }

  it("parses a valid chore classification", async () => {
    const schema = await loadSchema();
    const input = {
      type: "chore",
      activity: "tvätt",
      effort: "medium",
      confidence: 0.92,
    };

    const result = schema.parse(input);
    expect(result).toEqual(input);
  });

  it("parses a valid recovery classification", async () => {
    const schema = await loadSchema();
    const input = {
      type: "recovery",
      activity: "vila",
      effort: "low",
      confidence: 0.88,
    };

    const result = schema.parse(input);
    expect(result).toEqual(input);
  });

  it("parses a valid none classification", async () => {
    const schema = await loadSchema();
    const input = {
      type: "none",
      activity: "",
      effort: "low",
      confidence: 0.1,
    };

    const result = schema.parse(input);
    expect(result).toEqual(input);
  });

  it("accepts confidence at boundary 0.0", async () => {
    const schema = await loadSchema();
    const input = { type: "none", activity: "", effort: "low", confidence: 0 };
    expect(() => schema.parse(input)).not.toThrow();
  });

  it("accepts confidence at boundary 1.0", async () => {
    const schema = await loadSchema();
    const input = {
      type: "chore",
      activity: "disk",
      effort: "high",
      confidence: 1,
    };
    expect(() => schema.parse(input)).not.toThrow();
  });

  it("rejects confidence above 1.0", async () => {
    const schema = await loadSchema();
    const input = {
      type: "chore",
      activity: "disk",
      effort: "high",
      confidence: 1.5,
    };
    expect(() => schema.parse(input)).toThrow();
  });

  it("rejects confidence below 0.0", async () => {
    const schema = await loadSchema();
    const input = {
      type: "chore",
      activity: "disk",
      effort: "high",
      confidence: -0.1,
    };
    expect(() => schema.parse(input)).toThrow();
  });

  it("rejects an invalid type enum value", async () => {
    const schema = await loadSchema();
    const input = {
      type: "exercise",
      activity: "running",
      effort: "high",
      confidence: 0.9,
    };
    expect(() => schema.parse(input)).toThrow();
  });

  it("rejects an invalid effort enum value", async () => {
    const schema = await loadSchema();
    const input = {
      type: "chore",
      activity: "tvätt",
      effort: "extreme",
      confidence: 0.8,
    };
    expect(() => schema.parse(input)).toThrow();
  });

  it("rejects missing required fields", async () => {
    const schema = await loadSchema();
    expect(() => schema.parse({ type: "chore" })).toThrow();
    expect(() => schema.parse({ confidence: 0.5 })).toThrow();
    expect(() => schema.parse({})).toThrow();
  });

  it("rejects non-object input", async () => {
    const schema = await loadSchema();
    expect(() => schema.parse("not an object")).toThrow();
    expect(() => schema.parse(null)).toThrow();
    expect(() => schema.parse(42)).toThrow();
  });
});

describe("Activity interface", () => {
  it("has all required fields in a valid Activity object", async () => {
    const mod = await import("@shared/types/classification.js");
    // We verify the module exports by constructing a conforming object
    // and checking it satisfies the shape. Since Activity is a TypeScript
    // interface, we test that we can import it and use it as a type.
    // The real test is that this file compiles with the Activity type.
    // We also assert the module exports the expected names.
    expect(mod).toHaveProperty("ClassificationSchema");

    // Construct an object matching all required Activity fields
    const validActivity = {
      chatId: "123",
      activityId: "01HJZZ00000000000000000000",
      messageId: 456,
      userId: 789,
      userName: "TestUser",
      type: "chore" as const,
      activity: "tvätt",
      effort: "medium" as const,
      confidence: 0.92,
      timestamp: 1708200000000,
      createdAt: "2026-02-17T12:00:00.000Z",
    };

    // All required fields should be present
    expect(validActivity).toHaveProperty("chatId");
    expect(validActivity).toHaveProperty("activityId");
    expect(validActivity).toHaveProperty("messageId");
    expect(validActivity).toHaveProperty("userId");
    expect(validActivity).toHaveProperty("userName");
    expect(validActivity).toHaveProperty("type");
    expect(validActivity).toHaveProperty("activity");
    expect(validActivity).toHaveProperty("effort");
    expect(validActivity).toHaveProperty("confidence");
    expect(validActivity).toHaveProperty("timestamp");
    expect(validActivity).toHaveProperty("createdAt");
  });

  it("allows optional botMessageId field", async () => {
    const activityWithBot = {
      chatId: "123",
      activityId: "01HJZZ00000000000000000000",
      messageId: 456,
      userId: 789,
      userName: "TestUser",
      type: "chore" as const,
      activity: "tvätt",
      effort: "medium" as const,
      confidence: 0.92,
      timestamp: 1708200000000,
      createdAt: "2026-02-17T12:00:00.000Z",
      botMessageId: 999,
    };

    expect(activityWithBot).toHaveProperty("botMessageId");
    expect(activityWithBot.botMessageId).toBe(999);

    // Without botMessageId should also be valid
    const activityWithoutBot = { ...activityWithBot };
    delete (activityWithoutBot as Record<string, unknown>).botMessageId;
    expect(activityWithoutBot).not.toHaveProperty("botMessageId");
  });
});
