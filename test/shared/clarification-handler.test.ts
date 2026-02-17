import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Hoisted mocks ----
const {
  mockPutAlias,
  mockIncrementConfirmation,
  mockGetAliasesForChat,
  mockClassifyMessage,
  mockExtractNegationRemainder,
} = vi.hoisted(() => ({
  mockPutAlias: vi.fn(),
  mockIncrementConfirmation: vi.fn(),
  mockGetAliasesForChat: vi.fn(),
  mockClassifyMessage: vi.fn(),
  mockExtractNegationRemainder: vi.fn(),
}));

// ---- Module mocks ----
vi.mock("@shared/services/alias-store.js", () => ({
  putAlias: mockPutAlias,
  incrementConfirmation: mockIncrementConfirmation,
  getAliasesForChat: mockGetAliasesForChat,
}));

vi.mock("@shared/services/classifier.js", () => ({
  classifyMessage: mockClassifyMessage,
}));

vi.mock("@shared/data/swedish-patterns.js", () => ({
  AFFIRMATIVE_PATTERNS: /^(?:ja|japp|jepp|jo|precis|absolut|aa|mm|okej|jadå)$/i,
  NEGATION_PATTERNS: /^(?:nej|nä|nää|nix|nope)$/i,
  extractNegationRemainder: mockExtractNegationRemainder,
}));

// ---- Constants ----
const TABLE_NAME = "HomeOps-Table";
const CHAT_ID = "-100123456";
const USER_ID = "42";
const API_KEY = "sk-test-key";

const BASE_PARAMS = {
  tableName: TABLE_NAME,
  chatId: CHAT_ID,
  userId: USER_ID,
  apiKey: API_KEY,
};

describe("clarification-handler", () => {
  let handleClarificationReply: typeof import("@shared/services/clarification-handler.js").handleClarificationReply;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@shared/services/clarification-handler.js");
    handleClarificationReply = mod.handleClarificationReply;
  });

  describe("extracting suggested activity from bot text", () => {
    it("extracts the activity from 'Menade du diskning?'", async () => {
      mockGetAliasesForChat.mockResolvedValue([]);
      mockPutAlias.mockResolvedValue(undefined);

      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du diskning?",
        userReplyText: "ja",
      });

      expect(result.handled).toBe(true);
      expect(result.activity).toBe("diskning");
    });

    it("extracts multi-word activities from 'Menade du ta hand om barn?'", async () => {
      mockGetAliasesForChat.mockResolvedValue([]);
      mockPutAlias.mockResolvedValue(undefined);

      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du ta hand om barn?",
        userReplyText: "ja",
      });

      expect(result.handled).toBe(true);
      expect(result.activity).toBe("ta hand om barn");
    });
  });

  describe("non-clarification bot message", () => {
    it("returns not_clarification when replyToText does not match the pattern", async () => {
      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Tack, noterat!",
        userReplyText: "ja",
      });

      expect(result).toEqual({ handled: false, reason: "not_clarification" });
    });

    it("returns not_clarification for empty replyToText", async () => {
      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "",
        userReplyText: "ja",
      });

      expect(result).toEqual({ handled: false, reason: "not_clarification" });
    });
  });

  describe("affirmative reply", () => {
    it("calls putAlias with the suggested activity when user confirms", async () => {
      mockGetAliasesForChat.mockResolvedValue([]);
      mockPutAlias.mockResolvedValue(undefined);

      await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du diskning?",
        userReplyText: "ja",
      });

      expect(mockPutAlias).toHaveBeenCalledOnce();
      expect(mockPutAlias).toHaveBeenCalledWith(
        expect.objectContaining({
          canonicalActivity: "diskning",
        }),
      );
    });

    it("returns confirmed result with the activity", async () => {
      mockGetAliasesForChat.mockResolvedValue([]);
      mockPutAlias.mockResolvedValue(undefined);

      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du diskning?",
        userReplyText: "japp",
      });

      expect(result).toEqual({
        handled: true,
        action: "confirmed",
        activity: "diskning",
      });
    });

    it("handles various affirmative words: mm, okej, precis", async () => {
      for (const word of ["mm", "okej", "precis"]) {
        vi.clearAllMocks();
        mockGetAliasesForChat.mockResolvedValue([]);
        mockPutAlias.mockResolvedValue(undefined);

        const result = await handleClarificationReply({
          ...BASE_PARAMS,
          replyToText: "Menade du städa?",
          userReplyText: word,
        });

        expect(result.handled).toBe(true);
        expect(result.action).toBe("confirmed");
      }
    });

    it("calls incrementConfirmation when alias already exists", async () => {
      mockGetAliasesForChat.mockResolvedValue([
        {
          alias: "disk",
          canonicalActivity: "diskning",
          confirmations: 2,
          source: "learned",
        },
      ]);
      mockIncrementConfirmation.mockResolvedValue(undefined);

      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du diskning?",
        userReplyText: "ja",
      });

      expect(mockIncrementConfirmation).toHaveBeenCalledOnce();
      expect(mockPutAlias).not.toHaveBeenCalled();
      expect(result).toEqual({
        handled: true,
        action: "confirmed",
        activity: "diskning",
      });
    });
  });

  describe("corrective reply", () => {
    it("classifies the remainder after stripping the negation prefix", async () => {
      mockExtractNegationRemainder.mockReturnValue("jag menade tvätt");
      mockGetAliasesForChat.mockResolvedValue([]);
      mockClassifyMessage.mockResolvedValue({
        type: "chore",
        activity: "tvätt",
        effort: "medium",
        confidence: 0.9,
      });
      mockPutAlias.mockResolvedValue(undefined);

      await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du diskning?",
        userReplyText: "nej, jag menade tvätt",
      });

      expect(mockExtractNegationRemainder).toHaveBeenCalledWith(
        "nej, jag menade tvätt",
      );
      expect(mockClassifyMessage).toHaveBeenCalledWith(
        "jag menade tvätt",
        API_KEY,
        expect.anything(),
      );
    });

    it("creates alias with classifier activity when confidence >= 0.70", async () => {
      mockExtractNegationRemainder.mockReturnValue("tvätt");
      mockGetAliasesForChat.mockResolvedValue([]);
      mockClassifyMessage.mockResolvedValue({
        type: "chore",
        activity: "tvätt",
        effort: "medium",
        confidence: 0.85,
      });
      mockPutAlias.mockResolvedValue(undefined);

      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du diskning?",
        userReplyText: "nej, tvätt",
      });

      expect(mockPutAlias).toHaveBeenCalledOnce();
      expect(mockPutAlias).toHaveBeenCalledWith(
        expect.objectContaining({
          canonicalActivity: "tvätt",
        }),
      );
      expect(result).toEqual({
        handled: true,
        action: "corrected",
        activity: "tvätt",
      });
    });

    it("returns corrected result at exactly 0.70 confidence", async () => {
      mockExtractNegationRemainder.mockReturnValue("sophantering");
      mockGetAliasesForChat.mockResolvedValue([]);
      mockClassifyMessage.mockResolvedValue({
        type: "chore",
        activity: "sophantering",
        effort: "low",
        confidence: 0.7,
      });
      mockPutAlias.mockResolvedValue(undefined);

      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du diskning?",
        userReplyText: "nä, sophantering",
      });

      expect(result).toEqual({
        handled: true,
        action: "corrected",
        activity: "sophantering",
      });
    });
  });

  describe("low-confidence correction", () => {
    it("returns low_confidence when classifier confidence < 0.70", async () => {
      mockExtractNegationRemainder.mockReturnValue("nåt annat");
      mockGetAliasesForChat.mockResolvedValue([]);
      mockClassifyMessage.mockResolvedValue({
        type: "none",
        activity: "",
        effort: "low",
        confidence: 0.4,
      });

      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du diskning?",
        userReplyText: "nej, nåt annat",
      });

      expect(result).toEqual({ handled: false, reason: "low_confidence" });
      expect(mockPutAlias).not.toHaveBeenCalled();
    });

    it("does not create alias when classifier returns confidence 0.69", async () => {
      mockExtractNegationRemainder.mockReturnValue("typ grejer");
      mockGetAliasesForChat.mockResolvedValue([]);
      mockClassifyMessage.mockResolvedValue({
        type: "chore",
        activity: "grejer",
        effort: "low",
        confidence: 0.69,
      });

      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du diskning?",
        userReplyText: "nä, typ grejer",
      });

      expect(result).toEqual({ handled: false, reason: "low_confidence" });
      expect(mockPutAlias).not.toHaveBeenCalled();
    });
  });

  describe("ambiguous reply", () => {
    it("returns ambiguous when reply is not affirmative and not a negation", async () => {
      mockExtractNegationRemainder.mockReturnValue(null);

      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du diskning?",
        userReplyText: "kanske",
      });

      expect(result).toEqual({ handled: false, reason: "ambiguous" });
    });

    it("returns ambiguous for random unrelated text", async () => {
      mockExtractNegationRemainder.mockReturnValue(null);

      const result = await handleClarificationReply({
        ...BASE_PARAMS,
        replyToText: "Menade du städa?",
        userReplyText: "vad finns det till middag?",
      });

      expect(result).toEqual({ handled: false, reason: "ambiguous" });
    });
  });
});
