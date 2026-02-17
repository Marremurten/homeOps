import { describe, it, expect } from "vitest";
import { routeResponse } from "@shared/services/channel-router.js";

// --- Types ---

type ContentType = "acknowledgment" | "clarification" | "adaptation_hint" | "query_result";
type ChatType = "private" | "group" | "supergroup";

interface RouteParams {
  contentType: ContentType;
  isDmOptedIn: boolean;
  chatType: ChatType;
}

function route(overrides: Partial<RouteParams> = {}): string {
  return routeResponse({
    contentType: "acknowledgment",
    isDmOptedIn: false,
    chatType: "group",
    ...overrides,
  });
}

// --- Tests ---

describe("channel-router routeResponse", () => {
  describe("acknowledgments", () => {
    it("returns 'group' for acknowledgments in group chats", () => {
      const result = route({ contentType: "acknowledgment", chatType: "group" });
      expect(result).toBe("group");
    });

    it("returns 'group' for acknowledgments in supergroup chats", () => {
      const result = route({ contentType: "acknowledgment", chatType: "supergroup" });
      expect(result).toBe("group");
    });

    it("returns 'dm' for acknowledgments in private chats", () => {
      const result = route({ contentType: "acknowledgment", chatType: "private" });
      expect(result).toBe("dm");
    });

    it("returns 'group' for acknowledgments regardless of DM opt-in status", () => {
      const result = route({
        contentType: "acknowledgment",
        chatType: "group",
        isDmOptedIn: true,
      });
      expect(result).toBe("group");
    });
  });

  describe("clarifications", () => {
    it("returns 'group' for clarifications in group chats", () => {
      const result = route({ contentType: "clarification", chatType: "group" });
      expect(result).toBe("group");
    });

    it("returns 'group' for clarifications in supergroup chats", () => {
      const result = route({ contentType: "clarification", chatType: "supergroup" });
      expect(result).toBe("group");
    });

    it("returns 'dm' for clarifications in private chats", () => {
      const result = route({ contentType: "clarification", chatType: "private" });
      expect(result).toBe("dm");
    });
  });

  describe("adaptation hints", () => {
    it("returns 'dm' for adaptation hints when DM opted in", () => {
      const result = route({
        contentType: "adaptation_hint",
        isDmOptedIn: true,
        chatType: "group",
      });
      expect(result).toBe("dm");
    });

    it("returns 'none' for adaptation hints when not DM opted in", () => {
      const result = route({
        contentType: "adaptation_hint",
        isDmOptedIn: false,
        chatType: "group",
      });
      expect(result).toBe("none");
    });

    it("returns 'none' for adaptation hints in supergroup when not opted in", () => {
      const result = route({
        contentType: "adaptation_hint",
        isDmOptedIn: false,
        chatType: "supergroup",
      });
      expect(result).toBe("none");
    });

    it("returns 'dm' for adaptation hints in private chats", () => {
      const result = route({
        contentType: "adaptation_hint",
        chatType: "private",
        isDmOptedIn: false,
      });
      expect(result).toBe("dm");
    });
  });

  describe("query results", () => {
    it("returns 'group' for query results in group chats", () => {
      const result = route({ contentType: "query_result", chatType: "group" });
      expect(result).toBe("group");
    });

    it("returns 'group' for query results in supergroup chats", () => {
      const result = route({ contentType: "query_result", chatType: "supergroup" });
      expect(result).toBe("group");
    });

    it("returns 'dm' for query results in private chats", () => {
      const result = route({ contentType: "query_result", chatType: "private" });
      expect(result).toBe("dm");
    });
  });

  describe("private chat always returns dm", () => {
    it("returns 'dm' for every content type in private chats", () => {
      const contentTypes: ContentType[] = [
        "acknowledgment",
        "clarification",
        "adaptation_hint",
        "query_result",
      ];

      for (const contentType of contentTypes) {
        const result = route({ contentType, chatType: "private" });
        expect(result).toBe("dm");
      }
    });

    it("returns 'dm' for private chats regardless of DM opt-in", () => {
      const result = route({
        contentType: "acknowledgment",
        chatType: "private",
        isDmOptedIn: false,
      });
      expect(result).toBe("dm");
    });
  });
});
