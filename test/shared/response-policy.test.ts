import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClassificationResult } from "@shared/types/classification.js";

// --- Hoisted mocks ---

const {
  mockIsQuietHours,
  mockGetStockholmDate,
  mockGetResponseCount,
  mockGetLastResponseAt,
  mockIsConversationFast,
  mockValidateTone,
} = vi.hoisted(() => ({
  mockIsQuietHours: vi.fn().mockReturnValue(false),
  mockGetStockholmDate: vi.fn().mockReturnValue("2026-02-17"),
  mockGetResponseCount: vi.fn().mockResolvedValue(0),
  mockGetLastResponseAt: vi.fn().mockResolvedValue(null),
  mockIsConversationFast: vi.fn().mockResolvedValue(false),
  mockValidateTone: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock("@shared/utils/stockholm-time.js", () => ({
  isQuietHours: mockIsQuietHours,
  getStockholmDate: mockGetStockholmDate,
}));

vi.mock("@shared/services/response-counter.js", () => ({
  getResponseCount: mockGetResponseCount,
  getLastResponseAt: mockGetLastResponseAt,
}));

vi.mock("@shared/services/fast-conversation.js", () => ({
  isConversationFast: mockIsConversationFast,
}));

vi.mock("@shared/utils/tone-validator.js", () => ({
  validateTone: mockValidateTone,
}));

// --- Import under test ---

import {
  evaluateResponsePolicy,
  CONFIDENCE_HIGH,
  CONFIDENCE_CLARIFY,
  DAILY_CAP,
  COOLDOWN_MINUTES,
} from "@shared/services/response-policy.js";

// --- Helpers ---

const BASE_PARAMS = {
  chatId: "-100123",
  senderUserId: 42,
  currentTimestamp: 1739800000, // arbitrary unix epoch
  messagesTableName: "test-messages",
  countersTableName: "test-counters",
};

function makeClassification(
  overrides: Partial<ClassificationResult> = {},
): ClassificationResult {
  return {
    type: "chore",
    activity: "disk",
    effort: "low",
    confidence: 0.90,
    ...overrides,
  };
}

function callPolicy(
  classificationOverrides: Partial<ClassificationResult> = {},
  extraParams: Record<string, unknown> = {},
) {
  return evaluateResponsePolicy({
    classification: makeClassification(classificationOverrides),
    ...BASE_PARAMS,
    ...extraParams,
  });
}

// --- Tests ---

describe("evaluateResponsePolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set default mock returns after clearing
    mockIsQuietHours.mockReturnValue(false);
    mockGetStockholmDate.mockReturnValue("2026-02-17");
    mockGetResponseCount.mockResolvedValue(0);
    mockGetLastResponseAt.mockResolvedValue(null);
    mockIsConversationFast.mockResolvedValue(false);
    mockValidateTone.mockReturnValue({ valid: true });
  });

  // 1. type=none
  describe("when classification type is none", () => {
    it("returns respond: false with reason 'none'", async () => {
      const result = await callPolicy({ type: "none", confidence: 0.95 });

      expect(result).toEqual({ respond: false, reason: "none" });
    });

    it("does not call any silence-check functions", async () => {
      await callPolicy({ type: "none", confidence: 0.95 });

      expect(mockIsQuietHours).not.toHaveBeenCalled();
      expect(mockGetResponseCount).not.toHaveBeenCalled();
      expect(mockGetLastResponseAt).not.toHaveBeenCalled();
      expect(mockIsConversationFast).not.toHaveBeenCalled();
    });
  });

  // 2. High confidence acknowledge
  describe("when confidence >= CONFIDENCE_HIGH and all silence checks pass", () => {
    it("returns respond: true with acknowledgment text", async () => {
      const result = await callPolicy({ confidence: 0.90 });

      expect(result.respond).toBe(true);
      expect(result.text).toContain("Noterat");
    });
  });

  // 3. Clarification range
  describe("when confidence is in clarification range", () => {
    it("returns respond: true with clarification text including the activity", async () => {
      const result = await callPolicy({
        confidence: 0.65,
        activity: "tvätt",
      });

      expect(result.respond).toBe(true);
      expect(result.text).toContain("Menade du");
      expect(result.text).toContain("tvätt");
    });

    it("returns clarification at confidence 0.50 (lower bound)", async () => {
      const result = await callPolicy({
        confidence: 0.50,
        activity: "disk",
      });

      expect(result.respond).toBe(true);
      expect(result.text).toContain("Menade du");
    });

    it("returns clarification at confidence 0.84", async () => {
      const result = await callPolicy({
        confidence: 0.84,
        activity: "matlagning",
      });

      expect(result.respond).toBe(true);
      expect(result.text).toContain("Menade du");
      expect(result.text).toContain("matlagning");
    });
  });

  // 4. Quiet hours
  describe("quiet hours", () => {
    it("returns respond: false with reason 'quiet_hours' during 22:00-07:00 Stockholm", async () => {
      mockIsQuietHours.mockReturnValue(true);

      const result = await callPolicy({ confidence: 0.90 });

      expect(result).toEqual({ respond: false, reason: "quiet_hours" });
    });
  });

  // 5. Daily cap
  describe("daily cap", () => {
    it("returns respond: false with reason 'daily_cap' when count >= DAILY_CAP", async () => {
      mockGetResponseCount.mockResolvedValue(3);

      const result = await callPolicy({ confidence: 0.90 });

      expect(result).toEqual({ respond: false, reason: "daily_cap" });
    });

    it("returns respond: false when count exceeds DAILY_CAP", async () => {
      mockGetResponseCount.mockResolvedValue(10);

      const result = await callPolicy({ confidence: 0.90 });

      expect(result).toEqual({ respond: false, reason: "daily_cap" });
    });
  });

  // 6. Fast conversation
  describe("fast conversation", () => {
    it("returns respond: false with reason 'fast_conversation' when conversation is fast-moving", async () => {
      mockIsConversationFast.mockResolvedValue(true);

      const result = await callPolicy({ confidence: 0.90 });

      expect(result).toEqual({ respond: false, reason: "fast_conversation" });
    });
  });

  // 7. Cooldown
  describe("cooldown", () => {
    it("returns respond: false with reason 'cooldown' when last response was within 15 minutes", async () => {
      // currentTimestamp is 1739800000; 10 minutes ago = 1739800000 - 600
      const tenMinutesAgoIso = new Date((BASE_PARAMS.currentTimestamp - 600) * 1000).toISOString();
      mockGetLastResponseAt.mockResolvedValue(tenMinutesAgoIso);

      const result = await callPolicy({ confidence: 0.90 });

      expect(result).toEqual({ respond: false, reason: "cooldown" });
    });

    it("allows response when last response was more than 15 minutes ago", async () => {
      // 20 minutes ago
      const twentyMinutesAgoIso = new Date((BASE_PARAMS.currentTimestamp - 1200) * 1000).toISOString();
      mockGetLastResponseAt.mockResolvedValue(twentyMinutesAgoIso);

      const result = await callPolicy({ confidence: 0.90 });

      expect(result.respond).toBe(true);
    });
  });

  // 8. Low confidence
  describe("low confidence", () => {
    it("returns respond: false with reason 'low_confidence' when confidence < 0.50", async () => {
      const result = await callPolicy({ confidence: 0.30 });

      expect(result).toEqual({ respond: false, reason: "low_confidence" });
    });

    it("returns respond: false at confidence 0.49", async () => {
      const result = await callPolicy({ confidence: 0.49 });

      expect(result).toEqual({ respond: false, reason: "low_confidence" });
    });
  });

  // 9. Directly addressed
  describe("when directly addressed (message mentions bot name)", () => {
    it("responds regardless of low confidence", async () => {
      const result = await callPolicy(
        { confidence: 0.20 },
        { botUsername: "HomeBot", messageText: "Hey @HomeBot what is this?" },
      );

      expect(result.respond).toBe(true);
      expect(result.text).toBeDefined();
    });

    it("still respects quiet hours even when directly addressed", async () => {
      mockIsQuietHours.mockReturnValue(true);

      const result = await callPolicy(
        { confidence: 0.20 },
        { botUsername: "HomeBot", messageText: "@HomeBot disk?" },
      );

      expect(result.respond).toBe(false);
      expect(result.reason).toBe("quiet_hours");
    });

    it("still respects daily cap when directly addressed", async () => {
      mockGetResponseCount.mockResolvedValue(3);

      const result = await callPolicy(
        { confidence: 0.20 },
        { botUsername: "HomeBot", messageText: "@HomeBot what?" },
      );

      expect(result.respond).toBe(false);
      expect(result.reason).toBe("daily_cap");
    });
  });

  // 10. Tone validation
  describe("tone validation", () => {
    it("returns respond: false with reason 'tone' when generated text fails validation", async () => {
      mockValidateTone.mockReturnValue({ valid: false, reason: "blame pattern detected" });

      const result = await callPolicy({ confidence: 0.90 });

      expect(result).toEqual({ respond: false, reason: "tone" });
    });

    it("allows response when tone validation passes", async () => {
      mockValidateTone.mockReturnValue({ valid: true });

      const result = await callPolicy({ confidence: 0.90 });

      expect(result.respond).toBe(true);
    });
  });

  // 11. Silence rules checked in order
  describe("silence rules are checked in priority order", () => {
    it("quiet_hours takes priority over daily_cap", async () => {
      mockIsQuietHours.mockReturnValue(true);
      mockGetResponseCount.mockResolvedValue(10);

      const result = await callPolicy({ confidence: 0.90 });

      expect(result.reason).toBe("quiet_hours");
    });

    it("daily_cap takes priority over fast_conversation", async () => {
      mockGetResponseCount.mockResolvedValue(5);
      mockIsConversationFast.mockResolvedValue(true);

      const result = await callPolicy({ confidence: 0.90 });

      expect(result.reason).toBe("daily_cap");
    });

    it("fast_conversation takes priority over cooldown", async () => {
      mockIsConversationFast.mockResolvedValue(true);
      const recentIso = new Date((BASE_PARAMS.currentTimestamp - 60) * 1000).toISOString();
      mockGetLastResponseAt.mockResolvedValue(recentIso);

      const result = await callPolicy({ confidence: 0.90 });

      expect(result.reason).toBe("fast_conversation");
    });

    it("cooldown takes priority over low_confidence", async () => {
      const recentIso = new Date((BASE_PARAMS.currentTimestamp - 60) * 1000).toISOString();
      mockGetLastResponseAt.mockResolvedValue(recentIso);

      const result = await callPolicy({ confidence: 0.30 });

      expect(result.reason).toBe("cooldown");
    });

    it("type=none is checked before any silence rule", async () => {
      mockIsQuietHours.mockReturnValue(true);
      mockGetResponseCount.mockResolvedValue(10);
      mockIsConversationFast.mockResolvedValue(true);

      const result = await callPolicy({ type: "none", confidence: 0.95 });

      expect(result.reason).toBe("none");
    });
  });

  // Exported constants
  describe("exported constants", () => {
    it("exports CONFIDENCE_HIGH as a number >= 0.85", () => {
      expect(typeof CONFIDENCE_HIGH).toBe("number");
      expect(CONFIDENCE_HIGH).toBeGreaterThanOrEqual(0.85);
    });

    it("exports CONFIDENCE_CLARIFY as a number >= 0.50", () => {
      expect(typeof CONFIDENCE_CLARIFY).toBe("number");
      expect(CONFIDENCE_CLARIFY).toBeGreaterThanOrEqual(0.50);
    });

    it("exports DAILY_CAP as a number equal to 3", () => {
      expect(DAILY_CAP).toBe(3);
    });

    it("exports COOLDOWN_MINUTES as a number equal to 15", () => {
      expect(COOLDOWN_MINUTES).toBe(15);
    });
  });

  // getStockholmDate is called to compute the date for counter lookups
  describe("date computation", () => {
    it("calls getStockholmDate to derive the date for counter lookups", async () => {
      await callPolicy({ confidence: 0.90 });

      expect(mockGetStockholmDate).toHaveBeenCalled();
    });

    it("passes the computed date to getResponseCount", async () => {
      mockGetStockholmDate.mockReturnValue("2026-06-15");

      await callPolicy({ confidence: 0.90 });

      expect(mockGetResponseCount).toHaveBeenCalledWith(
        BASE_PARAMS.countersTableName,
        BASE_PARAMS.chatId,
        "2026-06-15",
      );
    });

    it("passes the computed date to getLastResponseAt", async () => {
      mockGetStockholmDate.mockReturnValue("2026-06-15");

      await callPolicy({ confidence: 0.90 });

      expect(mockGetLastResponseAt).toHaveBeenCalledWith(
        BASE_PARAMS.countersTableName,
        BASE_PARAMS.chatId,
        "2026-06-15",
      );
    });
  });
});
