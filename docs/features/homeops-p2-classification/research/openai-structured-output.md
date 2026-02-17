# Research: OpenAI Structured Output for Swedish Household Classification

**Feature:** homeops-p2-classification
**Question:** How to reliably produce structured JSON classification output from OpenAI for Swedish household messages
**Date:** 2026-02-17

## Summary

OpenAI's Structured Outputs with `response_format: { type: "json_schema" }` is the most reliable approach for producing typed classification results. Combined with the `openai` npm package's `zodResponseFormat` helper, it provides 100% schema-adherent JSON with automatic TypeScript type inference. For this use case, `gpt-4o-mini` is the recommended model: it costs approximately $0.0001 per classification, handles Swedish well, and supports structured outputs natively. Confidence calibration remains the hardest problem -- prompted confidence scores from LLMs are poorly calibrated, so we should combine prompt techniques with a log-probability fallback strategy.

---

## 1. Structured Output Methods Comparison

OpenAI provides three methods for obtaining JSON from the API. Here is a comparison relevant to our classification task.

### 1a. JSON Mode (`response_format: { type: "json_object" }`)

- Guarantees valid JSON output
- Does NOT guarantee schema adherence -- the model might return `{"classification": "chore"}` instead of `{"type": "chore"}`
- Requires the word "JSON" in the system prompt or it errors
- No automatic parsing or type safety
- **Not recommended** for this use case

### 1b. Function Calling / Tool Use with `strict: true`

- Originally designed for the model to call external tools
- When used with `strict: true`, provides the same schema-adherent JSON guarantee as Structured Outputs
- Adds semantic overhead: we are not really "calling a tool", we are extracting structured data
- Slightly more complex API surface (tools array, tool_choice parameter)
- Useful when you need the model to decide *whether* to call a function, but we always want classification output
- **Viable but unnecessarily complex** for this use case

### 1c. Structured Outputs (`response_format: { type: "json_schema", json_schema: {...} }`)

- Guarantees both valid JSON AND schema adherence via constrained decoding
- Uses JSON Schema to define the exact output structure
- The `openai` SDK provides `zodResponseFormat()` helper for automatic Zod-to-JSON-Schema conversion
- Automatic parsing via `client.beta.chat.completions.parse()` returns typed objects
- Supports refusal detection when the model declines for safety reasons
- **Recommended approach** for this use case

### Failure Modes for Structured Outputs

1. **Truncation**: If the response hits `max_completion_tokens` before completing the JSON, the output will be invalid. Mitigation: set a generous `max_completion_tokens` (200 is more than enough for our small schema).
2. **Refusal**: The model may refuse for safety reasons. The parsed response will have `refusal` set instead of `parsed`. Mitigation: check for refusal before accessing parsed data.
3. **Value errors**: Structured Outputs guarantees schema structure but NOT semantic correctness. The model could return `{"type": "chore", "confidence": 0.99}` for a message about the weather. Mitigation: prompt engineering and confidence thresholds.

### JSON Schema Restrictions

When using `strict: true` structured outputs:
- `additionalProperties` must be set to `false` on all objects
- All fields must be listed in `required`
- No support for `oneOf`, `anyOf`, `patternProperties`
- Maximum 100 object properties total, 5 levels of nesting
- No `default` values
- These restrictions are handled automatically when using `zodResponseFormat()`

## 2. Recommended Implementation

### 2a. Dependencies

```
pnpm add openai zod
```

The `openai` package (v4.55.0+) includes structured output support. Zod is an optional peer dependency needed only for the `zodResponseFormat` helper. Both are tree-shakeable with esbuild.

### 2b. Schema Definition (Zod)

```typescript
// src/shared/types/classification.ts
import { z } from "zod";

export const ClassificationSchema = z.object({
  type: z.enum(["chore", "recovery", "none"]),
  activity: z.string().describe("Activity name in Swedish, e.g. 'tvätt', 'disk'. Empty string for type 'none'."),
  effort: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1).describe("Classification confidence from 0.0 to 1.0"),
});

export type Classification = z.infer<typeof ClassificationSchema>;
```

### 2c. OpenAI Client Setup

```typescript
// src/shared/utils/openai.ts
import OpenAI from "openai";
import { getSecret } from "./secrets.js";

let clientPromise: Promise<OpenAI> | null = null;

export function getOpenAIClient(): Promise<OpenAI> {
  if (!clientPromise) {
    clientPromise = getSecret(process.env.OPENAI_API_KEY_ARN!).then(
      (apiKey) =>
        new OpenAI({
          apiKey,
          timeout: 10_000, // 10 seconds
          maxRetries: 1,   // 1 retry (total 2 attempts)
        }),
    );
  }
  return clientPromise;
}
```

### 2d. Classification Call

```typescript
// src/shared/services/classifier.ts
import { zodResponseFormat } from "openai/helpers/zod";
import { ClassificationSchema, type Classification } from "../types/classification.js";
import { getOpenAIClient } from "../utils/openai.js";
import { SYSTEM_PROMPT } from "./prompts.js";

export interface ClassificationResult {
  classification: Classification | null;
  error?: string;
}

export async function classifyMessage(text: string): Promise<ClassificationResult> {
  try {
    const client = await getOpenAIClient();

    const completion = await client.beta.chat.completions.parse({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_completion_tokens: 200,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      response_format: zodResponseFormat(ClassificationSchema, "classification"),
    });

    const message = completion.choices[0]?.message;

    // Handle refusal
    if (message?.refusal) {
      return { classification: null, error: `Model refused: ${message.refusal}` };
    }

    // Handle missing parsed data
    if (!message?.parsed) {
      return { classification: null, error: "No parsed response from model" };
    }

    return { classification: message.parsed };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { classification: null, error: msg };
  }
}
```

Key details:
- `client.beta.chat.completions.parse()` returns a typed `ParsedChatCompletion<Classification>` where `message.parsed` is already the typed object (no manual `JSON.parse`)
- The `beta` namespace is used because the parse helper is still in beta in the SDK, but the underlying API endpoint is stable
- `zodResponseFormat(ClassificationSchema, "classification")` converts the Zod schema to JSON Schema and wraps it in the required `response_format` envelope
- `temperature: 0.2` provides deterministic-leaning output while allowing slight variation for confidence scores

## 3. Prompt Engineering

### 3a. System Prompt Design

The system prompt should be structured with static content first (for prompt caching) and be concise to minimize token costs.

```typescript
// src/shared/services/prompts.ts
export const SYSTEM_PROMPT = `You classify Swedish household messages into activities.

DEFINITIONS:
- chore: Any action contributing to household functioning (cleaning, cooking, childcare, errands, shopping, planning, repairs, laundry, dishes, taking out trash)
- recovery: Any energy-restoring activity (rest, hobbies, exercise, social outings, alone time, gaming, watching TV, spa, massage)
- none: Greetings, questions, logistics, opinions, news, anything not a chore or recovery activity

RULES:
1. Classify based on what the person DID or IS DOING, not what they plan to do
2. Future plans ("jag ska...", "jag kan ta...") are "none" - promises are handled elsewhere
3. If the message is ambiguous or could be either, classify as "none"
4. Activity name must be in Swedish, lowercase, single word or short phrase
5. For "none" classifications, set activity to "" and effort to "low"

EFFORT GUIDE:
- low: Quick tasks under 15 min (take out trash, wipe counter, fold a few items)
- medium: Standard tasks 15-60 min (vacuum, cook dinner, grocery run, a workout)
- high: Extended tasks over 60 min (deep clean, large shopping trip, full day childcare)

CONFIDENCE SCORING:
- 0.95-1.0: Explicit, unambiguous statement ("Jag tvättade", "Jag städade hela köket")
- 0.85-0.94: Clear but slightly informal ("Fixade köket", "Tog tvätten")
- 0.70-0.84: Likely but needs context ("Fixade grejer" - probably chore but vague)
- 0.50-0.69: Possible but ambiguous ("Var ute" - could be errand or recovery)
- 0.0-0.49: Unlikely match, lean toward "none"

EXAMPLES:
User: "Jag tvättade idag"
→ type: "chore", activity: "tvätt", effort: "medium", confidence: 0.95

User: "Tog disken efter middagen"
→ type: "chore", activity: "disk", effort: "low", confidence: 0.92

User: "Storstädade hela lägenheten"
→ type: "chore", activity: "storstädning", effort: "high", confidence: 0.97

User: "Var på gymmet i en timme"
→ type: "recovery", activity: "träning", effort: "medium", confidence: 0.93

User: "Tog en promenad"
→ type: "recovery", activity: "promenad", effort: "low", confidence: 0.90

User: "Chillade hemma och kollade på film"
→ type: "recovery", activity: "vila", effort: "low", confidence: 0.88

User: "Handlade på ICA"
→ type: "chore", activity: "mathandling", effort: "medium", confidence: 0.91

User: "Hämtade barnen från skolan"
→ type: "chore", activity: "hämta barn", effort: "low", confidence: 0.93

User: "Fixade middag"
→ type: "chore", activity: "matlagning", effort: "medium", confidence: 0.90

User: "Var på AW igår"
→ type: "recovery", activity: "after work", effort: "medium", confidence: 0.87

User: "Ska vi äta ute ikväll?"
→ type: "none", activity: "", effort: "low", confidence: 0.95

User: "Okej låter bra"
→ type: "none", activity: "", effort: "low", confidence: 0.98

User: "Jag kan ta disken sen"
→ type: "none", activity: "", effort: "low", confidence: 0.90

User: "Var ute och fixade lite"
→ type: "chore", activity: "ärenden", effort: "low", confidence: 0.65`;
```

### 3b. Swedish Household Vocabulary

Common Swedish phrases mapped to activity types:

**Chores:**
| Swedish | English | Effort |
|---------|---------|--------|
| tvätt / tvättade | laundry | medium |
| disk / diskade | dishes | low |
| städning / städade | cleaning | medium |
| storstädning | deep cleaning | high |
| dammsugning / dammsög | vacuuming | medium |
| matlagning / lagade mat | cooking | medium |
| mathandling / handlade | grocery shopping | medium |
| hämta barn | pick up kids | low |
| lämna barn | drop off kids | low |
| panta / pantade | recycling bottles | low |
| tvätta golvet | mopping | medium |
| byta lakan | change bedsheets | low |
| fixa middag / fixade käk | cook dinner | medium |
| rensa ur kylen | clean fridge | low |
| bära ut soporna | take out trash | low |

**Recovery:**
| Swedish | English | Effort |
|---------|---------|--------|
| träning / gymmet | exercise / gym | medium |
| promenad | walk | low |
| AW / after work | after-work social | medium |
| bio | cinema | low |
| vila / vilade | rest | low |
| bad / spa | bath / spa | low |
| fika (without kids) | coffee break | low |
| gaming / spelade | gaming | low-medium |
| yoga | yoga | medium |
| löpning / sprang | running | medium |

**None (common non-activity messages):**
- Questions: "Ska vi...?", "Vill du...?", "Har du...?"
- Future plans: "Jag ska...", "Jag kan ta...", "Jag fixar det sen"
- Responses: "Okej", "Låter bra", "Jag vet inte"
- Logistics: "Jag är hemma kl 5", "Barnen sover"
- Opinions/chat: Weather, news, feelings, general conversation

### 3c. Handling Ambiguity

The system prompt encodes the PRD principle "precision over recall" by:

1. **Defaulting to "none"** for ambiguous messages
2. **Excluding future plans** -- "Jag kan ta disken sen" is classified as "none" because it is a promise, not a completed activity (promise detection is Phase 5 scope)
3. **Lower confidence for vague messages** -- "Fixade lite grejer" gets confidence ~0.65, below the 0.85 response threshold
4. **The confidence band between 0.50-0.84** maps to the clarification range from the PRD

## 4. Model Selection and Cost

### 4a. Model Comparison

| Aspect | gpt-4o-mini | gpt-4o |
|--------|------------|--------|
| Input tokens (per 1M) | $0.15 | $2.50 |
| Output tokens (per 1M) | $0.60 | $10.00 |
| Structured outputs | Yes | Yes |
| Swedish understanding | Good (50+ languages) | Excellent |
| Latency (typical) | 300-800ms | 500-1500ms |
| Context window | 128K | 128K |
| Cost ratio | 1x | ~17x |

### 4b. Cost Estimation Per Classification

For a typical classification request:

**Input tokens:**
- System prompt (with examples): ~700 tokens
- User message (5-30 words): ~10-50 tokens
- Schema overhead: ~80 tokens
- **Total input: ~790-830 tokens**

**Output tokens:**
- JSON classification object: ~30-50 tokens
- **Total output: ~40 tokens**

**Cost per classification (gpt-4o-mini):**
- Input: 830 tokens * $0.15/1M = $0.000125
- Output: 40 tokens * $0.60/1M = $0.000024
- **Total: ~$0.00015 per classification**

**Daily cost at 200 messages/day:**
- 200 * $0.00015 = **$0.03/day = ~$0.90/month**

**With prompt caching (50% cache hit rate at $0.075/1M for cached tokens):**
- Cached input: 415 tokens * $0.075/1M = $0.000031
- Uncached input: 415 tokens * $0.15/1M = $0.000062
- Output: $0.000024
- **Total: ~$0.00012 per classification = ~$0.72/month**

**gpt-4o equivalent: ~$15/month** -- not justified for this task.

### 4c. Model Recommendation

**Use `gpt-4o-mini`** for the following reasons:

1. **Swedish competence**: GPT-4o-mini supports 50+ languages with strong multilingual performance. Swedish is well within its capabilities, especially for short household messages with familiar vocabulary.
2. **Cost**: At ~$0.90/month vs ~$15/month for gpt-4o, the 17x price difference is not justified for short-text classification.
3. **Latency**: gpt-4o-mini is faster, helping stay within the 2-second end-to-end latency target from Phase 1.
4. **Structured output support**: Both models support structured outputs equally well.
5. **Classification quality**: For a well-constrained classification with clear categories and few-shot examples, gpt-4o-mini is sufficient. The task does not require deep reasoning.

If classification quality issues emerge with Swedish edge cases, the model can be swapped to `gpt-4o` with no code changes -- only the model string needs updating.

## 5. Error Handling and Timeouts

### 5a. Timeout Configuration

The current Worker Lambda has a **30-second timeout** (see `/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts` line 39). The SQS visibility timeout is **180 seconds** (line 29).

Recommended OpenAI client timeouts:
- **Connection timeout**: 10 seconds (covers DNS, TLS handshake, connection establishment)
- **Request timeout**: 10 seconds (for the full request/response cycle)
- **Total budget**: 10 seconds for OpenAI + headroom for DynamoDB writes and Telegram sends

This leaves ~20 seconds of headroom within the 30-second Lambda timeout. However, with Phase 2 adding OpenAI calls + potential Telegram response sends, consider **increasing the Lambda timeout to 60 seconds** and the SQS visibility timeout to **360 seconds** (must be >= 6x Lambda timeout for safety).

### 5b. Error Types and Handling

| Error | HTTP Code | Auto-Retry | Our Action |
|-------|-----------|------------|------------|
| Rate limit | 429 | Yes (SDK) | Let SDK retry once, then fail gracefully |
| Server error | 500/502/503 | Yes (SDK) | Let SDK retry once, then fail gracefully |
| Timeout | - | Yes (SDK) | Let SDK retry once, then fail gracefully |
| Bad request | 400 | No | Log error, skip classification |
| Auth error | 401 | No | Log error, skip classification |
| Refusal | 200 (refusal) | No | Log, skip classification |
| Malformed response | 200 (parse error) | No | Log, skip classification |

### 5c. Failure Strategy

The critical principle from the PRD: **failed classifications must not block the pipeline** (Phase 2 PRD, In Scope section 1).

```typescript
// Pseudocode for worker error handling
const result = await classifyMessage(text);

if (result.error) {
  // Log the error but do NOT throw -- the message was already stored in Phase 1
  console.error(JSON.stringify({
    level: "error",
    event: "classification_failed",
    messageId: body.messageId,
    chatId: body.chatId,
    error: result.error,
  }));
  // Return normally -- message is stored, classification is skipped
  // The SQS message is deleted (acknowledged) because the raw message save succeeded
  return;
}

if (result.classification && result.classification.type !== "none") {
  await storeActivity(result.classification, body);
}
```

**Key decisions:**
- A classification failure does NOT cause a Lambda error (which would trigger SQS retry)
- The raw message was already stored by the existing worker logic
- Classification is a best-effort enhancement -- missing one is acceptable (precision over recall)
- Errors are logged with structured JSON for CloudWatch monitoring

### 5d. SDK Choice: Official `openai` Package

**Use the official `openai` npm package** rather than raw HTTP for these reasons:

1. **Structured output helpers**: `zodResponseFormat()` and `client.beta.chat.completions.parse()` provide automatic schema conversion and type-safe parsing
2. **Built-in retry logic**: Automatic exponential backoff for 429, 500, 502, 503, 408 errors
3. **Timeout handling**: Configurable per-client and per-request timeouts
4. **TypeScript types**: Full type coverage for all API responses
5. **Tree-shakeable**: ESM-compatible, works with esbuild bundling (already used in the project)
6. **Active maintenance**: Official OpenAI package, updated frequently

**Bundle size consideration**: The `openai` package is relatively lightweight. With esbuild tree-shaking (already configured in the CDK `NodejsFunction` bundling), only the used modules are included. The chat completions module and Zod helper are the primary code paths.

## 6. Confidence Calibration

This is the most challenging aspect. Research shows that LLM-prompted confidence scores are poorly calibrated -- GPT-4o-mini has been observed producing >80% confidence on 66.7% of its errors.

### 6a. Prompt-Based Calibration (Primary Strategy)

The system prompt (Section 3a) uses several techniques:

1. **Explicit confidence bands**: Define what each confidence range means with concrete examples
2. **Anchoring examples**: Show the model diverse confidence levels (0.65, 0.87, 0.90, 0.95, 0.98)
3. **Penalty for over-confidence**: "If the message is ambiguous, classify as none" discourages high-confidence misclassification
4. **Separation of structure and semantics**: The model sees that "none" can be high-confidence (0.95-0.98) and "chore" can be low-confidence (0.65), breaking the pattern of type=chore always meaning high confidence

### 6b. Temperature Setting

- **`temperature: 0.2`** is recommended for classification
- Lower temperature (0.0) produces deterministic output but tends to push confidence scores to extreme values (all 0.95+)
- Slightly above zero (0.2) allows the model to express uncertainty through the confidence field while keeping classifications stable
- Higher temperatures (0.5+) introduce unwanted randomness in the type/activity fields

### 6c. Log Probability Approach (Future Enhancement)

OpenAI's `logprobs` parameter is compatible with structured outputs and could provide a second confidence signal:

```typescript
const completion = await client.beta.chat.completions.parse({
  model: "gpt-4o-mini",
  // ... other params ...
  logprobs: true,
  top_logprobs: 3,
  response_format: zodResponseFormat(ClassificationSchema, "classification"),
});

// Access token-level probabilities
const logprobs = completion.choices[0]?.logprobs?.content;
```

The log probability of the tokens corresponding to the `type` field value ("chore", "recovery", "none") can be extracted and converted to a probability: `confidence = Math.exp(logprob)`. This provides a model-internal confidence metric that is orthogonal to the prompted confidence score.

**Recommendation**: Start with prompt-based confidence only (simpler). Add logprobs as a Phase 3 enhancement if the prompted confidence proves poorly calibrated in practice. The `structured-logprobs` npm package provides utilities for mapping structured output fields to their token-level probabilities.

### 6d. Practical Confidence Thresholds (from PRD)

| Confidence Range | Action |
|-----------------|--------|
| >= 0.85 | Log activity, may acknowledge in chat |
| 0.50 - 0.84 | May ask clarification ("Menade du tvätt?") |
| < 0.50 | Treat as "none", no action |

These thresholds should be treated as tunable configuration, not hardcoded constants, so they can be adjusted based on observed behavior.

## 7. Token Optimization

### 7a. System Prompt Size

The current system prompt with all few-shot examples is approximately **700 tokens**. This is intentionally compact:

- English system prompt (more token-efficient than Swedish for instructions)
- Short example format (one line per example, no verbose explanations)
- No redundant instructions

### 7b. Prompt Caching

OpenAI automatically caches prompts >= 1024 tokens with no code changes. Our system prompt at ~700 tokens is just below this threshold. Options:

1. **Accept no caching**: At $0.90/month, the savings from caching (~20-30%) are negligible ($0.18-0.27/month)
2. **Pad the prompt to 1024 tokens**: Add more few-shot examples to cross the threshold. This would improve both caching AND classification quality.
3. **Use `prompt_cache_key`**: This API parameter improves cache hit rates by influencing server routing.

**Recommendation**: Option 2 -- add more few-shot examples to bring the system prompt to ~1024 tokens. This simultaneously improves classification quality and enables caching. Additional examples should cover edge cases like:
- Compound messages: "Städade och tvättade" (multiple chores)
- Emoji-heavy messages: "Gymmet idag" with emoji
- Slang: "Dammade" (vacuumed, informal)
- Negation: "Hann inte handla" (didn't manage to shop -- should be "none")

### 7c. Output Token Minimization

The classification schema is already minimal (~30-50 output tokens). Setting `max_completion_tokens: 200` provides safety margin while preventing runaway generation. No further optimization needed for output.

### 7d. Caching the OpenAI Client

The existing secrets caching pattern in `/Users/martinnordlund/homeOps/src/shared/utils/secrets.ts` (5-minute TTL cache) should be reused for the OpenAI client. The client instance should be created once per Lambda cold start and reused across invocations (module-scope promise pattern shown in Section 2c).

## 8. Zod vs Raw JSON Schema

### Trade-off Analysis

**Option A: Zod schema with `zodResponseFormat()`**
- Pros: Type inference via `z.infer`, runtime validation, single source of truth for types and schema
- Cons: Adds `zod` dependency (~50KB minified), slight complexity
- Fits: TypeScript-first codebase, already using esbuild

**Option B: Raw JSON Schema with manual types**
- Pros: No extra dependency, full control over schema
- Cons: Types and schema can drift, no runtime validation, more boilerplate
- Fits: Minimal dependency philosophy

**Recommendation**: Use Zod. The codebase is TypeScript-first, the dependency is small and tree-shakeable, and the `zodResponseFormat` helper eliminates an entire class of bugs (schema/type mismatch). The `openai` SDK was designed to work with Zod.

---

## Recommendation

1. **Use Structured Outputs** with `response_format: { type: "json_schema" }` via the `openai` SDK's `zodResponseFormat()` helper. This provides 100% schema adherence with automatic TypeScript type inference.

2. **Use `gpt-4o-mini`** as the model. It is 17x cheaper than gpt-4o, handles Swedish well, and is fast enough for the 2-second latency target. The model string should be a configurable constant for easy swapping.

3. **Use the official `openai` npm package** with `zod` for schema definition. Set `timeout: 10_000` and `maxRetries: 1` on the client.

4. **Handle errors gracefully**: Classification failures are logged but do not block the pipeline. The raw message (stored in Phase 1) is the source of truth; classification is best-effort.

5. **Start with prompt-based confidence calibration** using explicit bands and diverse few-shot examples. Consider adding logprobs-based confidence as a Phase 3 enhancement.

6. **Set `temperature: 0.2`** for stable classification with slight confidence variation.

7. **Consider increasing the Worker Lambda timeout** from 30s to 60s (and SQS visibility timeout from 180s to 360s) to accommodate the additional OpenAI API latency.

## Trade-offs

| Choice | Benefit | Cost |
|--------|---------|------|
| gpt-4o-mini over gpt-4o | 17x cheaper, faster | Slightly lower quality on edge cases |
| Structured Outputs over function calling | Simpler API surface, cleaner code | Locked to models that support it (all current ones do) |
| Zod dependency | Type safety, single source of truth | +50KB bundle size, extra dependency |
| Prompt-based confidence over logprobs | Simpler implementation | Less accurate confidence calibration |
| 10s OpenAI timeout | Predictable Lambda duration | May miss slow responses (rare) |
| `maxRetries: 1` | Limits Lambda duration | Slightly lower success rate on transient errors |
| Graceful failure (skip vs retry) | Pipeline never blocks | Some messages may lack classification |

## Open Questions

1. **Compound messages**: How should "Städade och tvättade" (cleaned and did laundry) be handled? Log as one activity or two? The current schema supports only one classification per message. Phase 3 could add multi-activity extraction.

2. **Message edits**: If a user edits their message, should the classification be updated? The Phase 1 ingest Lambda currently skips edited messages (`edit_date` check). This may need revisiting.

3. **Photo messages**: Some household activities might be reported with photos ("Look at the clean kitchen" + photo). Phase 1 only processes text messages. Photo understanding would require gpt-4o vision capabilities at higher cost.

4. **Prompt tuning iteration**: The system prompt examples are based on reasonable Swedish household vocabulary but should be validated against real message data. A feedback loop for prompt improvement should be considered for Phase 3.

5. **Model version pinning**: Should we pin to a specific model snapshot (e.g., `gpt-4o-mini-2024-07-18`) or use the rolling `gpt-4o-mini` alias? Pinning provides stability but requires manual updates; the alias auto-upgrades but could change behavior.

6. **Clarification response language**: The PRD specifies clarification in Swedish ("Menade du tvätt?"). Should the model generate this text, or should we use templates? Templates are more predictable; model-generated text is more natural but riskier.
