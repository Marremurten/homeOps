# Verification Report: homeops-p2-classification

**Feature:** Message Understanding & Activity Logging
**Date:** 2026-02-17
**Overall Assessment:** Ship with fixes

---

## Test Suite

**267/267 tests passing** across 19 test files. No failures, no skips.

---

## Critical Issues (must fix before shipping)

### 1. Worker handler does not return `SQSBatchResponse`

**File:** `src/handlers/worker/index.ts:14`
**Source:** Code Review (B1)

The CDK infra configures `reportBatchItemFailures: true` on the SQS event source mapping, but the handler returns `Promise<void>` instead of `SQSBatchResponse`. This means SQS will either retry all messages or none in a batch, defeating partial failure reporting. The handler should return `{ batchItemFailures: [{ itemIdentifier }] }` for failed records.

### 2. Worker test timestamps use milliseconds, but Telegram sends seconds

**File:** `test/handlers/worker.test.ts:71`, `src/shared/services/response-policy.ts:47`
**Source:** Code Review (B2)

Test fixtures use `timestamp: 1234567890000` (milliseconds), but Telegram's `message.date` is Unix seconds. The response policy multiplies by 1000 (`new Date(currentTimestamp * 1000)`), which is correct for seconds input but produces year ~41,000 with the test's millisecond value. Tests pass but don't validate real-world behavior.

### 3. Missing `botMessageId` update on activity after Telegram send

**File:** `src/handlers/worker/index.ts:103-125`
**Source:** Code Review (B3)

Plan Decision #6 requires storing the Telegram `message_id` of bot responses on the activity record. The current implementation calls `saveActivity` before the Telegram send (so `botMessageId` is unknown), and never updates the activity afterward. Only `incrementResponseCount` is called after a successful send.

---

## Security Findings

**Overall: PASS -- no blocking security issues.**

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| S1 | Prompt injection via user messages to OpenAI | MEDIUM | Mitigated by structured output + templated responses |
| S2 | Bot token could appear in error logs | LOW | Mitigated by current error handling pattern |
| S3 | Non-timing-safe webhook secret comparison | LOW | Pre-existing (Phase 1), hard to exploit over network |
| S4 | No input length validation on message text | LOW | Telegram caps at 4096 chars, manageable cost |
| S5 | userName stored without sanitization | LOW | DynamoDB handles safely, no render context |
| S6 | chatId type inconsistency (number vs string) | LOW | Works via implicit coercion |
| S7 | Missing error handling in `getBotInfo()` | MEDIUM | Worker catches it, but poor error attribution |
| S8 | Activity text in clarification from OpenAI | LOW | Templated format limits blast radius |
| S9 | No timestamp validation on message body | LOW | Webhook secret gates all input |
| S10 | No API Gateway throttling configured | MEDIUM | Pre-existing (Phase 1), cost-spike risk |

**Supply chain:** All 3 new deps (openai, zod, ulidx) are reputable. No concerns.
**IAM:** All grants follow least-privilege. No overly broad permissions.
**Secrets:** All via Secrets Manager with runtime caching. No hardcoded secrets.

---

## Test Coverage vs PRD Success Criteria

| # | PRD Criterion | Status |
|---|---------------|--------|
| 1 | Worker calls OpenAI to classify every message | COVERED |
| 2 | Messages classified as chore/recovery/none with confidence | COVERED |
| 3 | Activities stored in DynamoDB with full schema | COVERED |
| 4 | Silent for type=none | COVERED |
| 5 | Silent when confidence < 0.85 (unless clarification) | COVERED |
| 6 | Silent outside quiet hours (22:00-07:00 Stockholm) | COVERED |
| 7 | Silent when daily cap (3/chat) reached | COVERED |
| 8 | Silent during fast conversations (>3 msgs/60s) | COVERED |
| 9 | Clarification at 0.50-0.84 (max 5 words) | PARTIAL -- no 5-word max assertion |
| 10 | Output limits: <=1 line, neutral tone, <=1 emoji | PARTIAL -- line/emoji constraints not tested |
| 11 | No blame/comparison/commands/judgment | COVERED |
| 12 | Telegram Bot API used for responses | COVERED |
| 13 | Response counter tracks daily limit | COVERED |
| 14 | OpenAI errors handled gracefully | COVERED |
| 15 | Failed Telegram sends don't cause retries | COVERED |

**13/15 fully covered, 2/15 partially covered** (output format constraints -- low risk due to template-based responses).

---

## Scope Check

No scope creep detected. The implementation matches the PRD scope exactly:

- No alias learning, effort learning, or preference tracking (deferred to Phase 3)
- No balance calculation or fairness engine (Phase 4)
- No proactive behavior or scheduling (Phase 5)
- No DM insights (Phase 6)
- `lastResponseAt` field on response_counters is a valid plan-level decision (#14), not scope creep

---

## Suggestions (non-blocking)

1. **Confidence band alignment** -- System prompt uses different bands than PRD specifies (`classifier.ts:26-30`)
2. **OpenAI client reuse** -- Client created on every `classifyMessage` call; could cache per API key (`classifier.ts:48-51`)
3. **Activity type narrowing** -- `Activity.type` includes `"none"` but activities are only stored for chore/recovery (`classification.ts:18`)
4. **chatId explicit stringification** -- Ingest should `String(message.chat.id)` to match `MessageBody` type
5. **Timestamp parameter naming** -- Consider `currentTimestampSec` for clarity in `fast-conversation.ts`
6. **`getBotInfo` error handling** -- Add try-catch consistent with `sendMessage` pattern
7. **`@ts-expect-error` over `as any`** -- For OpenAI beta API cast in `classifier.ts:53-54`

---

## Fixes Required Before Shipping

1. **Fix worker return type** -- Return `SQSBatchResponse` with `batchItemFailures` array instead of `void`
2. **Fix test timestamps** -- Use seconds-scale values (e.g., `1234567890`) in worker test fixtures to match Telegram's `message.date`
3. **Implement `botMessageId` update** -- After successful Telegram send, update the activity record with the bot's `message_id` (requires an `UpdateItemCommand` call or passing `botMessageId` to `saveActivity`)
