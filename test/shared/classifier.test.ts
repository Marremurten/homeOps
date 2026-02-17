import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockParse } = vi.hoisted(() => ({
  mockParse: vi.fn(),
}));

const { mockZodResponseFormat } = vi.hoisted(() => ({
  mockZodResponseFormat: vi.fn().mockReturnValue({ type: "json_schema", json_schema: {} }),
}));

const { MockOpenAI } = vi.hoisted(() => ({
  MockOpenAI: vi.fn().mockImplementation(function () {
    return {
      chat: {
        completions: {
          parse: mockParse,
        },
      },
    };
  }),
}));

vi.mock("openai", () => ({
  default: MockOpenAI,
}));

vi.mock("openai/helpers/zod", () => ({
  zodResponseFormat: mockZodResponseFormat,
}));

import { classifyMessage, CLASSIFICATION_MODEL } from "@shared/services/classifier.js";
import type { ClassificationResult } from "@shared/types/classification.js";

describe("classifyMessage", () => {
  const API_KEY = "sk-test-key-123";
  const MESSAGE_TEXT = "Jag diskade hela köket";

  const FALLBACK_RESULT: ClassificationResult = {
    type: "none",
    activity: "",
    effort: "low",
    confidence: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CLASSIFICATION_MODEL constant", () => {
    it("exports gpt-4o-mini as the classification model", () => {
      expect(CLASSIFICATION_MODEL).toBe("gpt-4o-mini");
    });
  });

  describe("OpenAI client construction", () => {
    it("constructs the OpenAI client with the provided API key and 10s timeout", async () => {
      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed: { type: "chore", activity: "disk", effort: "medium", confidence: 0.92 } } }],
      });

      await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(MockOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: API_KEY,
          timeout: 10_000,
        }),
      );
    });
  });

  describe("API call parameters", () => {
    it("calls client.chat.completions.parse with correct model, temperature, max_completion_tokens, and zodResponseFormat", async () => {
      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed: { type: "chore", activity: "disk", effort: "medium", confidence: 0.92 } } }],
      });

      await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(mockParse).toHaveBeenCalledOnce();
      expect(mockParse).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-4o-mini",
          temperature: 0.2,
          max_completion_tokens: 200,
          response_format: { type: "json_schema", json_schema: {} },
        }),
      );
    });

    it("passes zodResponseFormat with the classification schema", async () => {
      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed: { type: "none", activity: "", effort: "low", confidence: 0.1 } } }],
      });

      await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(mockZodResponseFormat).toHaveBeenCalledOnce();
      expect(mockZodResponseFormat).toHaveBeenCalledWith(
        expect.anything(),
        "classification",
      );
    });

    it("includes the user message text in the messages array", async () => {
      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed: { type: "none", activity: "", effort: "low", confidence: 0.1 } } }],
      });

      await classifyMessage(MESSAGE_TEXT, API_KEY);

      const callArgs = mockParse.mock.calls[0][0];
      const userMessage = callArgs.messages.find(
        (m: { role: string; content: string }) => m.role === "user",
      );
      expect(userMessage).toBeDefined();
      expect(userMessage.content).toContain(MESSAGE_TEXT);
    });
  });

  describe("system prompt", () => {
    it("includes a system prompt in English with Swedish few-shot examples", async () => {
      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed: { type: "none", activity: "", effort: "low", confidence: 0.1 } } }],
      });

      await classifyMessage(MESSAGE_TEXT, API_KEY);

      const callArgs = mockParse.mock.calls[0][0];
      const systemMessage = callArgs.messages.find(
        (m: { role: string; content: string }) => m.role === "system",
      );
      expect(systemMessage).toBeDefined();
      expect(typeof systemMessage.content).toBe("string");

      // System prompt should be in English (contains English classification instructions)
      expect(systemMessage.content).toMatch(/classif/i);

      // System prompt should include Swedish few-shot examples
      // Common Swedish household words that should appear as examples
      const swedishExamples = ["städa", "diska", "tvätta"];
      const hasSwedishExamples = swedishExamples.some((word) =>
        systemMessage.content.toLowerCase().includes(word),
      );
      expect(hasSwedishExamples).toBe(true);
    });
  });

  describe("successful classification", () => {
    it("returns parsed ClassificationResult on success", async () => {
      const parsed: ClassificationResult = {
        type: "chore",
        activity: "disk",
        effort: "medium",
        confidence: 0.92,
      };

      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed } }],
      });

      const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(result).toEqual(parsed);
    });

    it("returns recovery classification on success", async () => {
      const parsed: ClassificationResult = {
        type: "recovery",
        activity: "vila",
        effort: "low",
        confidence: 0.88,
      };

      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed } }],
      });

      const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(result).toEqual(parsed);
    });

    it("returns none classification on success", async () => {
      const parsed: ClassificationResult = {
        type: "none",
        activity: "",
        effort: "low",
        confidence: 0.15,
      };

      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed } }],
      });

      const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(result).toEqual(parsed);
    });
  });

  describe("error handling - API errors", () => {
    it("returns fallback result on OpenAI API timeout error", async () => {
      mockParse.mockRejectedValueOnce(new Error("Request timed out"));

      const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(result).toEqual(FALLBACK_RESULT);
    });

    it("returns fallback result on OpenAI 5xx server error", async () => {
      mockParse.mockRejectedValueOnce(new Error("500 Internal Server Error"));

      const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(result).toEqual(FALLBACK_RESULT);
    });

    it("returns fallback result on OpenAI rate limit error", async () => {
      mockParse.mockRejectedValueOnce(new Error("429 Too Many Requests"));

      const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(result).toEqual(FALLBACK_RESULT);
    });

    it("does not throw on API error", async () => {
      mockParse.mockRejectedValueOnce(new Error("Network failure"));

      await expect(classifyMessage(MESSAGE_TEXT, API_KEY)).resolves.not.toThrow();
    });

    it("logs the error on API failure", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockParse.mockRejectedValueOnce(new Error("API error"));

      await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("error handling - parsing failures", () => {
    it("returns fallback result when parsed response is null", async () => {
      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed: null } }],
      });

      const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(result).toEqual(FALLBACK_RESULT);
    });

    it("returns fallback result when parsed response is undefined", async () => {
      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed: undefined } }],
      });

      const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(result).toEqual(FALLBACK_RESULT);
    });

    it("returns fallback result when choices array is empty", async () => {
      mockParse.mockResolvedValueOnce({
        choices: [],
      });

      const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(result).toEqual(FALLBACK_RESULT);
    });

    it("returns fallback result when response structure is malformed", async () => {
      mockParse.mockResolvedValueOnce({});

      const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

      expect(result).toEqual(FALLBACK_RESULT);
    });
  });

  describe("context-enriched classification", () => {
    const SUCCESSFUL_PARSED: ClassificationResult = {
      type: "chore",
      activity: "disk",
      effort: "medium",
      confidence: 0.92,
    };

    function mockSuccessfulParse() {
      mockParse.mockResolvedValueOnce({
        choices: [{ message: { parsed: SUCCESSFUL_PARSED } }],
      });
    }

    function getSystemPromptContent(): string {
      const callArgs = mockParse.mock.calls[0][0];
      const systemMessage = callArgs.messages.find(
        (m: { role: string; content: string }) => m.role === "system",
      );
      return systemMessage.content;
    }

    describe("aliases context", () => {
      it("includes 'Vocabulary context' section in system prompt when aliases are provided", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY, {
          aliases: [
            { alias: "disken", canonicalActivity: "diska" },
            { alias: "moppat", canonicalActivity: "moppa golv" },
          ],
        });

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).toContain("Vocabulary context");
      });

      it("lists each alias mapping in the system prompt", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY, {
          aliases: [
            { alias: "disken", canonicalActivity: "diska" },
            { alias: "moppat", canonicalActivity: "moppa golv" },
          ],
        });

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).toContain("disken");
        expect(systemPrompt).toContain("diska");
        expect(systemPrompt).toContain("moppat");
        expect(systemPrompt).toContain("moppa golv");
      });

      it("includes a single alias mapping when only one alias is provided", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY, {
          aliases: [{ alias: "tvätten", canonicalActivity: "tvätta" }],
        });

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).toContain("Vocabulary context");
        expect(systemPrompt).toContain("tvätten");
        expect(systemPrompt).toContain("tvätta");
      });

      it("does not include 'Vocabulary context' section when aliases array is empty", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY, { aliases: [] });

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).not.toContain("Vocabulary context");
      });
    });

    describe("effort EMA context", () => {
      it("includes 'Historical effort context' section in system prompt when effortEma is provided", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY, {
          effortEma: { activity: "diska", ema: 2.3 },
        });

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).toContain("Historical effort context");
      });

      it("includes the activity name and EMA value in the system prompt", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY, {
          effortEma: { activity: "diska", ema: 2.3 },
        });

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).toContain("diska");
        expect(systemPrompt).toContain("2.3");
      });

      it("does not include 'Historical effort context' when effortEma is not provided", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY, {
          aliases: [{ alias: "disken", canonicalActivity: "diska" }],
        });

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).not.toContain("Historical effort context");
      });
    });

    describe("combined context", () => {
      it("includes both 'Vocabulary context' and 'Historical effort context' when both are provided", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY, {
          aliases: [{ alias: "disken", canonicalActivity: "diska" }],
          effortEma: { activity: "diska", ema: 1.8 },
        });

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).toContain("Vocabulary context");
        expect(systemPrompt).toContain("Historical effort context");
      });

      it("still returns the parsed classification result when context is provided", async () => {
        mockSuccessfulParse();

        const result = await classifyMessage(MESSAGE_TEXT, API_KEY, {
          aliases: [{ alias: "disken", canonicalActivity: "diska" }],
          effortEma: { activity: "diska", ema: 1.8 },
        });

        expect(result).toEqual(SUCCESSFUL_PARSED);
      });
    });

    describe("backward compatibility (no context)", () => {
      it("does not include 'Vocabulary context' when no context parameter is passed", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY);

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).not.toContain("Vocabulary context");
      });

      it("does not include 'Historical effort context' when no context parameter is passed", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY);

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).not.toContain("Historical effort context");
      });

      it("does not include context sections when context is an empty object", async () => {
        mockSuccessfulParse();

        await classifyMessage(MESSAGE_TEXT, API_KEY, {});

        const systemPrompt = getSystemPromptContent();
        expect(systemPrompt).not.toContain("Vocabulary context");
        expect(systemPrompt).not.toContain("Historical effort context");
      });

      it("still returns the parsed result when no context is provided", async () => {
        mockSuccessfulParse();

        const result = await classifyMessage(MESSAGE_TEXT, API_KEY);

        expect(result).toEqual(SUCCESSFUL_PARSED);
      });
    });
  });
});
