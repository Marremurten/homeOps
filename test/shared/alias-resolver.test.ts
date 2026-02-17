import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetAliasesForChat } = vi.hoisted(() => ({
  mockGetAliasesForChat: vi.fn(),
}));

vi.mock("@shared/services/alias-store.js", () => ({
  getAliasesForChat: mockGetAliasesForChat,
}));

vi.mock("@shared/data/seed-aliases.js", () => ({
  SEED_ALIASES: {
    disk: "diskning",
    tvätt: "tvättning",
    städ: "städning",
  },
}));

const TABLE_NAME = "HomeOps-Aliases";
const CHAT_ID = "-100123456";

describe("alias-resolver", () => {
  let resolveAliases: typeof import("@shared/services/alias-resolver.js").resolveAliases;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-17T12:00:00.000Z"));

    // Re-import to get fresh module with cleared cache
    vi.resetModules();
    const mod = await import("@shared/services/alias-resolver.js");
    resolveAliases = mod.resolveAliases;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic resolution", () => {
    it("returns resolvedText and appliedAliases in the result", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      const result = await resolveAliases(TABLE_NAME, CHAT_ID, "hello");

      expect(result).toHaveProperty("resolvedText");
      expect(result).toHaveProperty("appliedAliases");
    });

    it("returns original text when no aliases match", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      const result = await resolveAliases(TABLE_NAME, CHAT_ID, "jag sprang en runda");

      expect(result.resolvedText).toBe("jag sprang en runda");
      expect(result.appliedAliases).toEqual([]);
    });

    it("replaces a seed alias in the text", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      const result = await resolveAliases(TABLE_NAME, CHAT_ID, "jag tog disk");

      expect(result.resolvedText).toContain("diskning");
      expect(result.appliedAliases).toHaveLength(1);
      expect(result.appliedAliases[0]).toEqual({
        alias: "disk",
        canonicalActivity: "diskning",
      });
    });

    it("replaces a learned alias from DynamoDB", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([
        { alias: "sopor", canonicalActivity: "sophantering", confirmations: 2, source: "learned" },
      ]);

      const result = await resolveAliases(TABLE_NAME, CHAT_ID, "tog ut sopor");

      expect(result.resolvedText).toContain("sophantering");
      expect(result.appliedAliases).toHaveLength(1);
      expect(result.appliedAliases[0]).toEqual({
        alias: "sopor",
        canonicalActivity: "sophantering",
      });
    });

    it("matches aliases case-insensitively", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      const result = await resolveAliases(TABLE_NAME, CHAT_ID, "Jag tog Disk idag");

      expect(result.resolvedText).toContain("diskning");
      expect(result.appliedAliases).toHaveLength(1);
    });

    it("matches aliases at word boundaries only", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      // "diskussion" contains "disk" but should NOT match at word boundary
      const result = await resolveAliases(TABLE_NAME, CHAT_ID, "hade en diskussion");

      expect(result.resolvedText).toBe("hade en diskussion");
      expect(result.appliedAliases).toEqual([]);
    });

    it("applies multiple aliases in the same text", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      const result = await resolveAliases(TABLE_NAME, CHAT_ID, "jag tog disk och tvätt");

      expect(result.resolvedText).toContain("diskning");
      expect(result.resolvedText).toContain("tvättning");
      expect(result.appliedAliases).toHaveLength(2);
    });
  });

  describe("learned aliases take precedence over seed aliases", () => {
    it("uses learned alias when it overrides a seed alias", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([
        { alias: "disk", canonicalActivity: "diskmaskin", confirmations: 5, source: "learned" },
      ]);

      const result = await resolveAliases(TABLE_NAME, CHAT_ID, "jag tog disk");

      // "disk" in seed maps to "diskning", but learned overrides to "diskmaskin"
      expect(result.resolvedText).toContain("diskmaskin");
      expect(result.resolvedText).not.toContain("diskning");
    });
  });

  describe("caching with 5-minute TTL", () => {
    it("queries DynamoDB on first call", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      await resolveAliases(TABLE_NAME, CHAT_ID, "test");

      expect(mockGetAliasesForChat).toHaveBeenCalledOnce();
      expect(mockGetAliasesForChat).toHaveBeenCalledWith(TABLE_NAME, CHAT_ID);
    });

    it("does NOT query DynamoDB on second call within 5-minute TTL", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      await resolveAliases(TABLE_NAME, CHAT_ID, "first call");

      mockGetAliasesForChat.mockClear();

      // Advance 4 minutes — still within TTL
      vi.advanceTimersByTime(4 * 60 * 1000);

      await resolveAliases(TABLE_NAME, CHAT_ID, "second call");

      expect(mockGetAliasesForChat).not.toHaveBeenCalled();
    });

    it("re-queries DynamoDB after TTL expires", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      await resolveAliases(TABLE_NAME, CHAT_ID, "first call");

      mockGetAliasesForChat.mockClear();
      mockGetAliasesForChat.mockResolvedValueOnce([
        { alias: "sopor", canonicalActivity: "sophantering", confirmations: 1, source: "learned" },
      ]);

      // Advance 5 minutes + 1ms — past TTL
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      await resolveAliases(TABLE_NAME, CHAT_ID, "third call");

      expect(mockGetAliasesForChat).toHaveBeenCalledOnce();
    });

    it("caches per chatId independently", async () => {
      const CHAT_ID_2 = "-100999888";
      mockGetAliasesForChat.mockResolvedValueOnce([]);
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      await resolveAliases(TABLE_NAME, CHAT_ID, "call for chat 1");
      await resolveAliases(TABLE_NAME, CHAT_ID_2, "call for chat 2");

      // Both chats should trigger separate queries
      expect(mockGetAliasesForChat).toHaveBeenCalledTimes(2);
      expect(mockGetAliasesForChat).toHaveBeenCalledWith(TABLE_NAME, CHAT_ID);
      expect(mockGetAliasesForChat).toHaveBeenCalledWith(TABLE_NAME, CHAT_ID_2);
    });

    it("uses fresh data after TTL expires", async () => {
      // First call: no learned aliases
      mockGetAliasesForChat.mockResolvedValueOnce([]);
      const result1 = await resolveAliases(TABLE_NAME, CHAT_ID, "sopor");
      expect(result1.appliedAliases).toEqual([]);

      // Advance past TTL
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      // Second call: now has a learned alias for "sopor"
      mockGetAliasesForChat.mockResolvedValueOnce([
        { alias: "sopor", canonicalActivity: "sophantering", confirmations: 2, source: "learned" },
      ]);

      const result2 = await resolveAliases(TABLE_NAME, CHAT_ID, "sopor");
      expect(result2.resolvedText).toContain("sophantering");
      expect(result2.appliedAliases).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("handles empty text", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([]);

      const result = await resolveAliases(TABLE_NAME, CHAT_ID, "");

      expect(result.resolvedText).toBe("");
      expect(result.appliedAliases).toEqual([]);
    });

    it("handles text with no words matching any alias", async () => {
      mockGetAliasesForChat.mockResolvedValueOnce([
        { alias: "sopor", canonicalActivity: "sophantering", confirmations: 1, source: "learned" },
      ]);

      const result = await resolveAliases(TABLE_NAME, CHAT_ID, "det regnar ute");

      expect(result.resolvedText).toBe("det regnar ute");
      expect(result.appliedAliases).toEqual([]);
    });

    it("propagates errors from getAliasesForChat", async () => {
      mockGetAliasesForChat.mockRejectedValueOnce(new Error("DynamoDB error"));

      await expect(resolveAliases(TABLE_NAME, CHAT_ID, "test")).rejects.toThrow("DynamoDB error");
    });
  });
});
