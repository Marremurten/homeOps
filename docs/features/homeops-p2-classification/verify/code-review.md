# Code Review: homeops-p2-classification

**Reviewer:** code-reviewer
**Date:** 2026-02-17
**Verdict:** Ship with fixes

---

## Summary

The Phase 2 classification implementation is well-structured, follows existing project conventions closely, and covers the PRD requirements thoroughly. The code is readable, error handling is consistent, and the test suite is comprehensive. There are a few blocking issues (one functional bug, one missing PRD requirement) and several minor suggestions.

---

## Blocking Issues

### B1. Worker handler does not return `SQSBatchResponse` (functional bug)

**File:** `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts:14`

The CDK infrastructure configures `reportBatchItemFailures: true` on the SQS event source mapping (`/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts:65`). When this is enabled, the Lambda handler **must** return an `SQSBatchResponse` with a `batchItemFailures` array. The current handler signature is `Promise<void>`, which means SQS will either retry all messages or none, defeating the purpose of batch item failure reporting.

```typescript
// Current (line 14):
export async function handler(event: SQSEvent): Promise<void> {

// Should be:
export async function handler(event: SQSEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
```

When the DynamoDB raw message write throws (non-idempotency error), that record's `messageId` should be added to `batchItemFailures` instead of throwing, so only the failed record is retried. This was also an issue in Phase 1 but becomes more critical now that the handler does more work per record.

**Severity:** Blocking -- mismatched infra config and handler return type can cause silent message loss or unnecessary retries.

### B2. Worker timestamp passed to services is in seconds vs milliseconds (ambiguity/potential bug)

**File:** `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts:72`

The test fixture sets `timestamp: 1234567890000` (which looks like milliseconds), but Telegram's `message.date` is Unix seconds. The `body.timestamp` is passed directly to:
- `saveActivity` at line 77 (seeds ULID with this value)
- `evaluateResponsePolicy` at line 91 (used as `currentTimestamp`)

In `response-policy.ts:47`, the value is then multiplied by 1000: `new Date(currentTimestamp * 1000)`, which would be correct **only if** `currentTimestamp` is in seconds.

However in the test at `/Users/martinnordlund/homeOps/test/handlers/worker.test.ts:71`, the timestamp is `1234567890000` (already milliseconds). If the policy receives this and multiplies by 1000 again, the Date will be wrong.

The Telegram API `message.date` is documented as Unix time in seconds. The ingest handler passes `message.date` directly as `timestamp`. So the runtime value will be seconds (correct for policy). But the test fixture value of `1234567890000` is incorrect -- it should be a seconds-scale value like `1234567890`. This means the worker tests are exercising an unrealistic code path.

**Severity:** Blocking -- test data is inconsistent with real Telegram input. The tests pass but do not validate real-world behavior. The timestamp `1234567890000` treated as seconds by `response-policy.ts` would produce a date in the year ~41,000.

### B3. Worker missing `botMessageId` update on activity after successful Telegram send

**File:** `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts:103-125`

The plan (Decision #6) and task 11-test (test case #7) specify: "After successful Telegram send, calls `incrementResponseCount` **and updates activity with `botMessageId`**." The current implementation increments the response counter but never updates the activity record with the `botMessageId` from the Telegram response.

The `saveActivity` call at line 69 happens before the Telegram send, so the `botMessageId` is unknown at that point. After a successful send (line 113), only `incrementResponseCount` is called. There is no `UpdateItemCommand` or second call to update the activity with `result.messageId`.

The test at `/Users/martinnordlund/homeOps/test/handlers/worker.test.ts:472-483` only checks that `incrementResponseCount` is called, not that the activity is updated. This matches the implementation but diverges from the plan.

**Severity:** Blocking -- plan requirement not implemented.

---

## Non-Blocking Issues

### N1. `eslint-disable` cast for OpenAI beta API

**File:** `/Users/martinnordlund/homeOps/src/shared/services/classifier.ts:53-54`

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const response = await (client as any).beta.chat.completions.parse({
```

The `as any` cast bypasses type safety on the OpenAI beta API. This is understandable since `beta.chat.completions.parse()` may not have stable types in `openai@^6.22.0`. However, a narrower approach would be preferable:

```typescript
const response = await client.beta.chat.completions.parse({...});
```

If the types exist in v6, the cast is unnecessary. If they don't, consider a `@ts-expect-error` with a comment explaining why, so it auto-resolves when types are updated.

**Severity:** Suggestion

### N2. `fast-conversation.ts` timestamp unit inconsistency with PRD

**File:** `/Users/martinnordlund/homeOps/src/shared/services/fast-conversation.ts:24`

The PRD says ">3 messages in last 60 seconds". The implementation uses `currentTimestamp - 60` as the cutoff. This is correct only if `currentTimestamp` is in seconds. Since this value ultimately comes from `body.timestamp` (which is Telegram `message.date`, Unix seconds), it works at runtime. But the function parameter name `currentTimestamp` doesn't document the expected unit, and callers might pass milliseconds.

Consider adding a JSDoc or renaming the parameter to `currentTimestampSec` for clarity.

**Severity:** Suggestion

### N3. OpenAI client instantiated on every call

**File:** `/Users/martinnordlund/homeOps/src/shared/services/classifier.ts:48-51`

```typescript
const client = new OpenAI({
  apiKey,
  timeout: 10_000,
});
```

A new OpenAI client is created on every invocation of `classifyMessage`. Since the API key comes from Secrets Manager with a 5-minute cache, the key is stable across invocations within a Lambda container. Creating a module-scope client (or caching it by API key) would avoid repeated setup, though the performance impact is likely negligible.

**Severity:** Suggestion -- minor optimization opportunity, not required.

### N4. `chatId` type inconsistency: string in MessageBody, number in Telegram

**File:** `/Users/martinnordlund/homeOps/src/shared/types/classification.ts:28`

`MessageBody.chatId` is typed as `string`. In the ingest handler (`/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts:40`), `message.chat.id` (a number) is assigned directly to `chatId` in the JSON body. When the worker parses this JSON, it becomes a number at runtime but is typed as string.

In the worker at line 108, `Number(body.chatId)` is called for the Telegram sender, which handles the conversion. In DynamoDB writes, `String(body.chatId)` is used. This works but relies on implicit JavaScript coercion behavior.

The ingest handler should explicitly stringify the chatId: `chatId: String(message.chat.id)` to match the `MessageBody` type definition.

**Severity:** Non-blocking but should be fixed for type safety.

### N5. `Activity` interface includes `type: "none"` which should never be stored

**File:** `/Users/martinnordlund/homeOps/src/shared/types/classification.ts:18`

```typescript
export interface Activity {
  // ...
  type: "chore" | "recovery" | "none";
```

Per the PRD, activities are only stored for `chore` or `recovery` classifications. The `Activity` type should be `type: "chore" | "recovery"` to prevent storing `none` activities. The worker correctly skips `none` at line 63, but the type doesn't enforce this.

**Severity:** Suggestion -- tighter typing would catch logic errors at compile time.

### N6. `getBotInfo` error handling is missing

**File:** `/Users/martinnordlund/homeOps/src/shared/services/telegram-sender.ts:50-63`

`getBotInfo` has no try-catch. If the `getMe` API call fails (network error, invalid token), it will throw an unhandled error. The module-scope cache means a failed first call will keep throwing on every subsequent call (since `cachedBotInfo` stays null). Unlike `sendMessage` which explicitly handles errors, `getBotInfo` lets them propagate.

In the worker, this is caught by the outer try-catch at line 97, but the error message won't clearly indicate it came from `getBotInfo`. Consider adding error handling or at minimum documenting that callers must handle exceptions.

**Severity:** Non-blocking -- worker catches it, but error attribution could be better.

### N7. Confidence band definitions in system prompt differ from PRD

**File:** `/Users/martinnordlund/homeOps/src/shared/services/classifier.ts:26-30`

PRD specifies: `0.95-1.0` (certain), `0.85-0.94` (high), `0.50-0.84` (uncertain), `0.0-0.49` (unlikely).

Implementation has: `0.85-1.0` (very confident), `0.6-0.84` (somewhat), `0.3-0.59` (low), `0.0-0.29` (very low).

The bands in the system prompt don't match the PRD. Since the prompt guides the model's confidence calibration, this could affect classification behavior. The response policy thresholds (0.85 and 0.50) are correctly implemented, but the model may score differently than intended if the prompt bands diverge.

**Severity:** Non-blocking but recommended to align with PRD bands.

### N8. Response-counter test uses `vi.useFakeTimers()` but import is at top level

**File:** `/Users/martinnordlund/homeOps/test/shared/response-counter.test.ts:1-23`

The module import happens at the top of the file (line 19-23), before `vi.useFakeTimers()` is called in `beforeEach`. This is fine because the time-dependent behavior is in `incrementResponseCount` which runs during the test, not at import time. Just noting this for awareness -- it works correctly.

**Severity:** No action needed.

---

## Scope Check

The implementation matches the PRD scope. No scope creep detected. Specifically:

- No alias learning, effort learning, or preference tracking (correctly deferred to Phase 3)
- No balance calculation or fairness engine (Phase 4)
- No proactive behavior or scheduling (Phase 5)
- No DM insights (Phase 6)
- Clarification follows the fixed template format as specified
- Decision #13 (classifying "Ja" normally) is correctly implemented -- no special-case logic

One minor addition beyond the PRD: the `lastResponseAt` field on response_counters was added per plan Decision #14. This is a valid plan-level decision, not scope creep.

---

## Pattern Compliance

| Pattern | Status | Notes |
|---------|--------|-------|
| ESM imports with `.js` extensions | PASS | All `@shared/*` imports use `.js` extension |
| `vi.hoisted()` for mock variables | PASS | Used correctly in all test files |
| `function` keyword for class mocks | PASS | `DynamoDBClient`, `OpenAI` mocks all use `function` |
| `vi.clearAllMocks()` in `beforeEach` | PASS | Present in all test files |
| Low-level DynamoDB client | PASS | No DocumentClient usage |
| Module-scope DynamoDB client singleton | PASS | All services use top-level `const client = new DynamoDBClient({})` |
| Node.js 22, ARM64, ESM bundling | PASS | CDK construct configured correctly |
| Secret caching via `getSecret()` | PASS | Worker uses the shared utility |
| `"type": "module"` in package.json | PASS | Already set |
| CDK RemovalPolicy.DESTROY | PASS | All new tables |
| On-demand billing, PITR | PASS | All new tables |

---

## Test Quality Assessment

The test suite is thorough:

- **classification-schema.test.ts**: Good boundary testing (confidence 0.0, 1.0, above, below). Covers invalid enums and missing fields.
- **stockholm-time.test.ts**: Excellent DST transition and midnight boundary coverage.
- **tone-validator.test.ts**: Tests all PRD-specified patterns with case-insensitivity. Good false-positive check.
- **classifier.test.ts**: Covers success, API errors, parsing failures, and parameter verification.
- **activity-store.test.ts**: Tests DynamoDB attribute types, ULID seeding, optional fields, and error propagation.
- **response-counter.test.ts**: Tests all three functions with edge cases. Uses fake timers for TTL verification.
- **fast-conversation.test.ts**: Good boundary testing (60s exactly, 61s), sender filtering, empty results.
- **telegram-sender.test.ts**: Covers success, HTTP error, network error, and caching behavior.
- **response-policy.test.ts**: Comprehensive silence rule ordering tests, boundary conditions, directly-addressed behavior.
- **CDK tests**: Verify resource counts, table schemas, IAM permissions, environment variables.
- **worker.test.ts**: Tests full pipeline including error isolation between stages.

Missing test coverage:
- Worker test does not verify `botMessageId` update (per B3 above -- plan requirement missing from both impl and test)
- Worker test timestamp values don't reflect real Telegram data (per B2 above)
- No test for `getBotInfo` failure path in the worker context
- `telegram-sender.test.ts` does not test `getBotInfo` when `fetch` throws (only tests success + caching)

---

## Files Reviewed

### Implementation (16 files):
- `/Users/martinnordlund/homeOps/src/shared/types/classification.ts`
- `/Users/martinnordlund/homeOps/src/shared/utils/stockholm-time.ts`
- `/Users/martinnordlund/homeOps/src/shared/utils/tone-validator.ts`
- `/Users/martinnordlund/homeOps/src/shared/services/classifier.ts`
- `/Users/martinnordlund/homeOps/src/shared/services/activity-store.ts`
- `/Users/martinnordlund/homeOps/src/shared/services/response-counter.ts`
- `/Users/martinnordlund/homeOps/src/shared/services/fast-conversation.ts`
- `/Users/martinnordlund/homeOps/src/shared/services/telegram-sender.ts`
- `/Users/martinnordlund/homeOps/src/shared/services/response-policy.ts`
- `/Users/martinnordlund/homeOps/infra/constructs/message-store.ts`
- `/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts`
- `/Users/martinnordlund/homeOps/infra/stack.ts`
- `/Users/martinnordlund/homeOps/infra/config.ts`
- `/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts`
- `/Users/martinnordlund/homeOps/src/shared/types/telegram.ts`
- `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts`

### Tests (14 files):
- `/Users/martinnordlund/homeOps/test/shared/classification-schema.test.ts`
- `/Users/martinnordlund/homeOps/test/shared/stockholm-time.test.ts`
- `/Users/martinnordlund/homeOps/test/shared/tone-validator.test.ts`
- `/Users/martinnordlund/homeOps/test/shared/classifier.test.ts`
- `/Users/martinnordlund/homeOps/test/shared/activity-store.test.ts`
- `/Users/martinnordlund/homeOps/test/shared/response-counter.test.ts`
- `/Users/martinnordlund/homeOps/test/shared/fast-conversation.test.ts`
- `/Users/martinnordlund/homeOps/test/shared/telegram-sender.test.ts`
- `/Users/martinnordlund/homeOps/test/shared/response-policy.test.ts`
- `/Users/martinnordlund/homeOps/test/infra/message-store.test.ts`
- `/Users/martinnordlund/homeOps/test/infra/message-processing.test.ts`
- `/Users/martinnordlund/homeOps/test/infra/stack.test.ts`
- `/Users/martinnordlund/homeOps/test/handlers/ingest.test.ts`
- `/Users/martinnordlund/homeOps/test/handlers/worker.test.ts`
