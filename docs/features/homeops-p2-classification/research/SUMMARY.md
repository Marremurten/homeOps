# Phase 2 Research Summary: Message Understanding & Activity Logging

**Synthesis Date:** 2026-02-17
**Sources:** codebase-analysis.md, openai-structured-output.md, telegram-responses.md, dynamodb-patterns.md

---

## Recommended Approach

Extend the existing Worker Lambda (not a new Lambda) to add classification, activity logging, and conditional Telegram responses. The pipeline order is critical: **store raw message first (existing), then classify, then optionally respond**. Classification and response failures must never block the pipeline or trigger SQS retries.

**Classification:** Use the `openai` SDK with `zodResponseFormat()` and `client.beta.chat.completions.parse()` to call `gpt-4o-mini` with Structured Outputs. Define the classification schema in Zod, which provides both the JSON Schema for the API and TypeScript types from a single source. System prompt in English with Swedish few-shot examples, `temperature: 0.2`, `max_completion_tokens: 200`.

**Activity Logging:** Write classified chore/recovery events to a new `homeops-activities` table with ULID sort keys (via `ulidx`, seeded with message timestamp). GSI `userId-timestamp-index` with `ALL` projection for per-user queries.

**Rate Limiting:** Atomic counter upsert in `homeops-response-counters` using DynamoDB `ADD` expression. Check-then-increment pattern (read count, send if under cap, then increment). Stockholm timezone dates via `Intl.DateTimeFormat` with `en-CA` locale -- zero dependencies, DST-safe.

**Telegram Responses:** Use native `fetch` (no SDK) to call `sendMessage` with `reply_parameters` and `allow_sending_without_reply: true`. Plain text only. Never retry failed sends. Cache bot identity from `getMe` at module scope.

**Silence Rules:** Query last 10 messages from `homeops-messages` with `ScanIndexForward: false` for fast conversation detection. Quiet hours check via `Intl.DateTimeFormat`. All silence checks run before any response attempt.

**CDK Changes:** New `ActivityStore` construct (separate from `MessageStore`) with both tables. Increase Worker timeout from 30s to 60s. Grant Worker permissions for new tables plus Secrets Manager reads for OpenAI key and Telegram token. Pass new table names and secret ARNs as environment variables.

---

## Key Findings

### Confirmed Expectations
- Phase 1 infrastructure is well-designed for extension; all integration points are clean
- OpenAI Structured Outputs with Zod provide 100% schema-adherent JSON -- no manual parsing needed
- `gpt-4o-mini` handles Swedish well at ~$0.90/month (200 msgs/day); gpt-4o at ~$15/month is not justified
- DynamoDB atomic `ADD` is naturally an upsert -- no conditional logic needed for counter initialization
- `Intl.DateTimeFormat` handles Stockholm DST transitions with zero dependencies
- Secrets caching pattern (5-min TTL) from Phase 1 directly reusable for OpenAI key and Telegram token
- Telegram rate limits (20 msgs/min per group) are irrelevant at 3 msgs/day max

### Surprising / Noteworthy
- **Confidence calibration is the hardest problem.** LLM-prompted confidence scores are poorly calibrated -- GPT-4o-mini produces >80% confidence on 66.7% of its errors. The prompt uses explicit confidence bands and diverse anchoring examples to mitigate this, but it will need real-world tuning.
- **`reply_to_message_id` is deprecated.** Telegram now uses `reply_parameters` object instead. All research code uses the modern API.
- **The existing `homeops` single-table (from Phase 1) goes unused.** The PRD specifies dedicated tables, and the research follows suit. This is a minor design tension (see Open Decisions).
- **Prompt caching threshold is 1024 tokens.** The system prompt at ~700 tokens misses it. Adding more few-shot examples to cross the threshold improves both caching and classification quality.
- **The messages table SK is `messageId` (Number), not `timestamp`.** Fast conversation detection cannot use a time-range key condition -- it queries last 10 items and filters in application code, which is efficient enough.

---

## Risks & Mitigations

| Priority | Risk | Mitigation |
|----------|------|------------|
| **High** | Confidence scores are poorly calibrated, leading to over-responding or missed activities | Explicit confidence bands in prompt; treat thresholds as tunable constants (not hardcoded); plan for logprobs-based calibration in Phase 3 |
| **High** | OpenAI API timeout or failure blocks message pipeline | 10s client timeout, 1 retry, then graceful failure (log + continue). Raw message already stored. |
| **Medium** | Compound messages ("Stadade och tvattade") classified as single activity -- loses data | Accept single classification per message for Phase 2. Multi-activity extraction is a Phase 3 candidate. |
| **Medium** | Timezone calculation wrong during DST transition (counter date boundary) | Use `Intl.DateTimeFormat` (not manual offset). Inject `Date` parameter for testability. |
| **Medium** | Bot privacy mode not disabled -- bot only receives mentions, not all messages | Document as a deployment prerequisite. Consider a health check that calls `getMe` and verifies `can_read_all_group_messages: true`. |
| **Low** | OpenAI quota exhausted | Monitor usage via OpenAI dashboard; fallback to silence (skip classification, log error) |
| **Low** | Atomic counter not idempotent on SQS retry -- may double-count | Acceptable per PRD: "slightly exceeding 3 is tolerable" |
| **Low** | DynamoDB TTL deletion delay (up to 48h) exposes stale counter items | Counter queries use today's date as SK, so expired items from old dates are naturally excluded |

---

## Open Decisions

These require a human call before implementation planning:

1. **Dedicated tables vs single-table design.** Phase 1 created a generic `homeops` table (pk/sk/gsi1pk/gsi1sk) intended for Phase 2+ entities. The PRD specifies dedicated `homeops-activities` and `homeops-response-counters` tables. Both approaches work. Dedicated tables are simpler to reason about and test; single-table reduces infrastructure. The research follows the PRD (dedicated tables), but this should be a conscious decision.

2. **New construct vs extend `MessageStore`.** The DynamoDB research proposes a new `ActivityStore` construct. The codebase research proposes adding tables to `MessageStore`. Either works -- it is an organizational decision. A new construct is cleaner for Phase 2 isolation but adds a file.

3. **ULID seeding: message timestamp vs processing time.** Seeding with message timestamp (`ulid(messageTimestamp)`) preserves chronological ordering when SQS is delayed. Seeding with current time (`ulid()`) reflects when the classification happened. The `timestamp` attribute stores original time regardless. Recommendation from research: seed with message timestamp.

4. **Model version pinning.** Use rolling `gpt-4o-mini` alias (auto-upgrades, may change behavior) or pin to a snapshot like `gpt-4o-mini-2024-07-18` (stable, requires manual updates)? The model string should be a configurable constant either way.

5. **Clarification text: templates vs model-generated.** The PRD specifies a format ("Menade du [activity]?") but does not prescribe the source. Templates are predictable and testable. Model-generated text is more natural but harder to enforce the 5-word limit. Research leans toward templates.

6. **Where to store the bot's sent `message_id`.** Options: (a) field on the activity item, (b) separate tracking, (c) response_counters table. Option (a) is simplest -- ties the response to the activity that triggered it.

---

## Conflicts

### Timeout and Memory Values
The codebase analysis recommends increasing Worker Lambda timeout from 30s to 60s and memory from 256 MB to 512 MB. The OpenAI research recommends 60s timeout but does not mention memory. The SQS visibility timeout (currently 180s) should also increase to 360s if the Lambda timeout doubles (must be >= 6x Lambda timeout). **Resolution:** Increase timeout to 60s, SQS visibility to 360s. Memory increase to 512 MB is optional -- the additional OpenAI SDK code is lightweight and 256 MB is likely sufficient. Monitor and adjust.

### Dedicated Tables vs Single-Table
The codebase analysis mentions the existing `homeops` single-table "reserved for Phase 2+ entities." The DynamoDB research follows the PRD and defines dedicated tables. These are contradictory signals from Phase 1 planning vs Phase 2 PRD. **Resolution:** Follow the PRD (dedicated tables). The `homeops` single-table can serve future entities that do not warrant their own table.

### Fast Conversation Detection: "Other Users" Definition
The PRD says "3+ messages from other users" in the last 60 seconds. The DynamoDB research clarifies that `currentUserId` should be the message sender's ID (not the bot's), since we want to detect fast conversation around the sender. The codebase analysis does not address this nuance. **Resolution:** Use the message sender's user ID as the exclusion criterion, not the bot's ID.

---

## New Dependencies

| Package | Version | Justification | Bundle Impact |
|---------|---------|---------------|---------------|
| `openai` | ^4.55.0 | Official SDK with structured output helpers (`zodResponseFormat`, `parse()`), built-in retry logic, timeout handling, TypeScript types | Tree-shakeable with esbuild; only chat completions module included |
| `zod` | ^3.x | Schema definition for classification output; single source of truth for JSON Schema (API) and TypeScript types; peer dependency of `openai` for structured outputs | ~50 KB minified, tree-shakeable |
| `ulidx` | ^2.x | ULID generation for time-ordered activity sort keys; TypeScript-native, ESM-compatible successor to unmaintained `ulid` package | ~5 KB minified |

**No new dependencies for:** timezone handling (`Intl.DateTimeFormat` built-in), Telegram API (native `fetch`), DynamoDB operations (existing `@aws-sdk/client-dynamodb`).

---

## Research Gaps

The following areas are relevant to Phase 2 but were not covered by the four research documents:

1. **Tone validation implementation.** The PRD specifies tone enforcement (no blame, comparison, commands, or judgment) with a fallback to silence. No research addressed how to implement this check -- whether it should be a keyword blocklist, a regex filter, or a secondary LLM call. Given the bot's responses are short templates ("Noterat", "Menade du X?"), a simple blocklist may suffice.

2. **Clarification follow-up handling.** When the bot asks "Menade du tvatt?" and the user replies "Ja", how does Phase 2 process that confirmation? The PRD marks clarification follow-up tracking as Phase 3 scope, but the Phase 2 reply-to-bot detection (from Telegram research) will surface these replies. Phase 2 needs at minimum to *not* re-classify the "Ja" as a new activity.

3. **Testing strategy for OpenAI integration.** The codebase analysis covers Vitest mock patterns, but no research addressed how to test the classification pipeline end-to-end (e.g., contract tests against OpenAI's structured output, snapshot tests for prompt changes, integration tests with recorded responses).

4. **Observability and monitoring.** Beyond basic CloudWatch logging, no research covered structured logging formats, metrics (classification latency, confidence distribution, response rate), or alerting for classification degradation.
