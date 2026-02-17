import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("sendMessage", () => {
  let sendMessage: typeof import("@shared/services/telegram-sender.js").sendMessage;

  beforeAll(async () => {
    const mod = await import("@shared/services/telegram-sender.js");
    sendMessage = mod.sendMessage;
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("calls fetch with correct Telegram sendMessage URL, method, and JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });

    await sendMessage({
      token: "bot-token-123",
      chatId: 999,
      text: "Hello world",
      replyToMessageId: 10,
    });

    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botbot-token-123/sendMessage");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.chat_id).toBe(999);
    expect(body.text).toBe("Hello world");
    expect(body.reply_parameters).toEqual({
      message_id: 10,
      allow_sending_without_reply: true,
    });
  });

  it("returns { ok: true, messageId } on successful response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 77 } }),
    });

    const result = await sendMessage({
      token: "bot-token-123",
      chatId: 100,
      text: "Test message",
      replyToMessageId: 5,
    });

    expect(result).toEqual({ ok: true, messageId: 77 });
  });

  it("returns { ok: false, error } on HTTP error without throwing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ ok: false, description: "Forbidden: bot was blocked by the user" }),
    });

    const result = await sendMessage({
      token: "bot-token-123",
      chatId: 100,
      text: "Should fail",
      replyToMessageId: 1,
    });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("error");
    expect((result as { ok: false; error: string }).error).toBeTruthy();
  });

  it("returns { ok: false, error } on network error without throwing", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network request failed"));

    const result = await sendMessage({
      token: "bot-token-123",
      chatId: 100,
      text: "Should fail",
      replyToMessageId: 1,
    });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("error");
    expect((result as { ok: false; error: string }).error).toContain("Network request failed");
  });
});

describe("getBotInfo", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.resetModules();
  });

  it("calls the getMe endpoint and returns bot id and username", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: { id: 123456, is_bot: true, first_name: "TestBot", username: "test_bot" },
      }),
    });

    const { getBotInfo } = await import("@shared/services/telegram-sender.js");
    const info = await getBotInfo("my-bot-token");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botmy-bot-token/getMe");

    expect(info).toEqual({ id: 123456, username: "test_bot" });
  });

  it("caches the result so a second call does not fetch again", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: { id: 789, is_bot: true, first_name: "CachedBot", username: "cached_bot" },
      }),
    });

    const { getBotInfo } = await import("@shared/services/telegram-sender.js");

    const first = await getBotInfo("cached-token");
    const second = await getBotInfo("cached-token");

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
    expect(first).toEqual({ id: 789, username: "cached_bot" });
  });
});
