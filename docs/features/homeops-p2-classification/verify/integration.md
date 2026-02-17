# Integration Test Verification: homeops-p2-classification

**Date:** 2026-02-17
**Test runner:** Vitest v4.0.18
**Node:** Node.js on Darwin arm64

---

## Test Suite Results

| File | Tests | Status |
|------|-------|--------|
| test/shared/classification-schema.test.ts | 13 | PASS |
| test/shared/stockholm-time.test.ts | 16 | PASS |
| test/shared/tone-validator.test.ts | 15 | PASS |
| test/shared/classifier.test.ts | 18 | PASS |
| test/shared/activity-store.test.ts | 9 | PASS |
| test/shared/response-counter.test.ts | 18 | PASS |
| test/shared/fast-conversation.test.ts | 13 | PASS |
| test/shared/telegram-sender.test.ts | 6 | PASS |
| test/shared/response-policy.test.ts | 31 | PASS |
| test/infra/message-store.test.ts | 27 | PASS |
| test/infra/message-processing.test.ts | 20 | PASS |
| test/infra/stack.test.ts | 8 | PASS |
| test/handlers/ingest.test.ts | 10 | PASS |
| test/handlers/worker.test.ts | 27 | PASS |
| test/shared/secrets.test.ts | 4 | PASS |
| test/shared/telegram-types.test.ts | 5 | PASS |
| test/handlers/health.test.ts | 8 | PASS |
| test/infra/ingestion-api.test.ts | 14 | PASS |
| test/setup.test.ts | 5 | PASS |

**Total: 19 files, 267 tests passed, 0 failed, 0 skipped**

---

## PRD Success Criteria Coverage

### 1. Worker Lambda calls OpenAI to classify every incoming Swedish message
**Status: COVERED**
- `test/handlers/worker.test.ts:335-346` -- "calls classifyMessage with message text and OpenAI API key after DynamoDB write"
- `test/shared/classifier.test.ts:74-121` -- verifies API call parameters (model, temperature, max_completion_tokens, zodResponseFormat)
- `test/shared/classifier.test.ts:123-148` -- verifies system prompt is in English with Swedish few-shot examples

### 2. Messages classified as `chore`, `recovery`, or `none` with confidence score
**Status: COVERED**
- `test/shared/classification-schema.test.ts:11-48` -- validates parsing of chore, recovery, and none types
- `test/shared/classification-schema.test.ts:50-65` -- validates confidence boundary values (0.0 and 1.0)
- `test/shared/classification-schema.test.ts:67-98` -- rejects out-of-range confidence, invalid type/effort enums
- `test/shared/classifier.test.ts:151-202` -- returns parsed ClassificationResult for all three types

### 3. Classified activities (chore/recovery) stored in DynamoDB `activities` table with full schema
**Status: COVERED**
- `test/shared/activity-store.test.ts:54-116` -- verifies PutItemCommand with correct table, PK (chatId), SK (activityId/ULID), and all DynamoDB attribute types (S/N)
- `test/shared/activity-store.test.ts:82-89` -- ULID seeded with message timestamp
- `test/shared/activity-store.test.ts:118-134` -- optional botMessageId included/omitted correctly
- `test/shared/classification-schema.test.ts:126-188` -- Activity interface has all required fields including optional botMessageId
- `test/handlers/worker.test.ts:348-399` -- worker calls saveActivity for chore and recovery classifications
- `test/infra/message-store.test.ts:157-228` -- CDK assertions: activities table has correct PK/SK, GSI (userId-timestamp-index), billing, PITR

### 4. Agent stays silent for messages classified as `none`
**Status: COVERED**
- `test/shared/response-policy.test.ts:98-113` -- returns `{ respond: false, reason: "none" }` and does not call any silence-check functions
- `test/handlers/worker.test.ts:402-415` -- worker does NOT call saveActivity or evaluateResponsePolicy when type is none

### 5. Agent stays silent when confidence < 0.85 (unless clarification range)
**Status: COVERED**
- `test/shared/response-policy.test.ts:225-237` -- returns `{ respond: false, reason: "low_confidence" }` when confidence < 0.50
- `test/shared/response-policy.test.ts:126-158` -- clarification at 0.50-0.84 range (boundary tests at 0.50 and 0.84)
- `test/shared/response-policy.test.ts:116-123` -- acknowledgment at confidence >= 0.85

### 6. Agent stays silent outside quiet hours (22:00-07:00 Stockholm)
**Status: COVERED**
- `test/shared/response-policy.test.ts:161-169` -- returns `{ respond: false, reason: "quiet_hours" }`
- `test/shared/stockholm-time.test.ts:52-127` -- comprehensive quiet hours tests: 22:00, 23:00, midnight, 03:00, 06:59 (true); 07:00, 12:00, 21:59 (false); DST CET/CEST transitions

### 7. Agent stays silent when daily response cap (3/chat) reached
**Status: COVERED**
- `test/shared/response-policy.test.ts:172-188` -- returns `{ respond: false, reason: "daily_cap" }` at count 3 and above
- `test/shared/response-counter.test.ts:40-90` -- getResponseCount sends correct GetItemCommand, returns count or 0
- `test/shared/response-counter.test.ts:92-198` -- incrementResponseCount with ADD expression, TTL, lastResponseAt
- `test/shared/response-policy.test.ts:347,374-396` -- date computation using getStockholmDate passed to counter functions

### 8. Agent stays silent during fast-moving conversations (>3 msgs/60s)
**Status: COVERED**
- `test/shared/response-policy.test.ts:191-199` -- returns `{ respond: false, reason: "fast_conversation" }`
- `test/shared/fast-conversation.test.ts:35-49` -- queries messages table with ScanIndexForward false, Limit 10
- `test/shared/fast-conversation.test.ts:52-95` -- returns true for 3+ messages from others within 60s
- `test/shared/fast-conversation.test.ts:98-142` -- returns false for < 3, empty, and old messages
- `test/shared/fast-conversation.test.ts:144-195` -- correctly filters out sender's own messages
- `test/shared/fast-conversation.test.ts:197-227` -- boundary conditions (exactly 60s, 61s)

### 9. Clarification questions sent when confidence is 0.50-0.84 (max 5 words)
**Status: PARTIALLY COVERED**
- `test/shared/response-policy.test.ts:126-158` -- verifies "Menade du [activity]?" text is generated for 0.50-0.84
- **Gap: No explicit test asserts the 5-word maximum constraint on clarification text.** The template "Menade du [activity]?" is inherently <= 5 words for single-word activities, but multi-word activity names are not tested.

### 10. All output respects limits: <= 1 line, neutral tone, <= 1 emoji
**Status: PARTIALLY COVERED**
- `test/shared/tone-validator.test.ts:1-126` -- validates neutral tone, rejects blame/comparison/commands/judgment
- `test/shared/response-policy.test.ts:277-293` -- tone validation gate: response suppressed if tone check fails
- **Gap: No test explicitly asserts the <= 1 line constraint.** The template-based responses ("Noterat", "Menade du X?") are inherently 1 line, but this is not validated programmatically.
- **Gap: No test explicitly asserts the <= 1 emoji constraint.** The "Noterat checkmark" has exactly 1 emoji, but no test checks for emoji count enforcement.

### 11. No responses contain blame, comparison, commands, or judgment
**Status: COVERED**
- `test/shared/tone-validator.test.ts:31-106` -- tests for blame ("du borde"), comparison ("mer an"), commands ("gor detta"), judgment ("bra jobbat", "daligt"), case-insensitive
- `test/shared/tone-validator.test.ts:116-125` -- no false positives on partial word matches
- `test/shared/response-policy.test.ts:277-284` -- tone validation suppresses response when validation fails

### 12. Telegram Bot API used to send responses back to group chat
**Status: COVERED**
- `test/shared/telegram-sender.test.ts:18-45` -- verifies fetch URL, method POST, JSON body with chat_id, text, reply_parameters (including allow_sending_without_reply)
- `test/shared/telegram-sender.test.ts:47-61` -- returns `{ ok: true, messageId }` on success
- `test/shared/telegram-sender.test.ts:99-141` -- getBotInfo calls getMe, caches result
- `test/handlers/worker.test.ts:438-458` -- worker calls sendMessage with correct token, chatId, text, replyToMessageId

### 13. Response counter tracks and enforces daily limit per chat
**Status: COVERED**
- `test/shared/response-counter.test.ts:40-90` -- getResponseCount with correct table/key
- `test/shared/response-counter.test.ts:92-198` -- incrementResponseCount with ADD atomic increment, TTL, updatedAt, lastResponseAt
- `test/shared/response-counter.test.ts:200-257` -- getLastResponseAt for cooldown check
- `test/shared/response-policy.test.ts:172-188` -- daily cap enforcement at DAILY_CAP (3)
- `test/handlers/worker.test.ts:472-483` -- worker calls incrementResponseCount after successful Telegram send

### 14. OpenAI API errors handled gracefully without blocking the pipeline
**Status: COVERED**
- `test/shared/classifier.test.ts:204-284` -- returns fallback `{ type: "none", ... }` on timeout, 5xx, rate limit, null/undefined/empty/malformed response; does not throw
- `test/shared/classifier.test.ts:236-243` -- logs error on API failure
- `test/handlers/worker.test.ts:485-492` -- worker continues without error when classifyMessage throws

### 15. Failed Telegram sends logged but do not cause message processing retries
**Status: COVERED**
- `test/shared/telegram-sender.test.ts:63-96` -- returns `{ ok: false, error }` on HTTP error and network error without throwing
- `test/handlers/worker.test.ts:494-508` -- worker continues without error when Telegram send returns ok: false; does NOT call incrementResponseCount

---

## Additional Coverage Analysis

### CDK Infrastructure Tests

- `test/infra/message-store.test.ts:17-19` -- exactly 4 DynamoDB tables
- `test/infra/message-store.test.ts:157-289` -- activities table (PK/SK, billing, PITR, GSI, deletion policy) and response-counters table (PK/SK, billing, PITR, TTL on ttl, deletion policy)
- `test/infra/message-store.test.ts:291-299` -- public properties activitiesTable and responseCountersTable exposed
- `test/infra/message-processing.test.ts:40-44` -- SQS visibility timeout updated to 360s
- `test/infra/message-processing.test.ts:72-77` -- Worker Lambda timeout updated to 60s
- `test/infra/message-processing.test.ts:145-183` -- New env vars: ACTIVITIES_TABLE_NAME, RESPONSE_COUNTERS_TABLE_NAME, OPENAI_API_KEY_ARN, TELEGRAM_BOT_TOKEN_ARN
- `test/infra/message-processing.test.ts:185-266` -- IAM grants: PutItem on activities, GetItem+UpdateItem on counters, Query on messages, secretsmanager:GetSecretValue
- `test/infra/stack.test.ts:24-27` -- Stack contains 4 DynamoDB tables
- `test/infra/stack.test.ts:54-58` -- Stack contains 3+ Secrets Manager secrets

### Ingest Lambda Reply Metadata

- `test/handlers/ingest.test.ts:213-294` -- replyToMessageId and replyToIsBot extraction from reply_to_message, absent when no reply, defaults replyToIsBot to false when from field missing

### Silence Rule Priority Order

- `test/shared/response-policy.test.ts:296-343` -- priority order verified: type=none > quiet_hours > daily_cap > fast_conversation > cooldown > low_confidence

### Error Resilience in Worker

- `test/handlers/worker.test.ts:280-303` -- DynamoDB ConditionalCheckFailedException caught (idempotency); non-conditional errors rethrown for SQS retry
- `test/handlers/worker.test.ts:510-516` -- saveActivity failure does not throw

---

## Issues Found

No bugs found during testing. All 267 tests pass cleanly.

The stderr output during test runs (e.g., "Classification failed:", "sendMessage failed:") is expected behavior -- these are logged errors from error-handling code paths being exercised.

CDK deprecation warnings for `pointInTimeRecovery` (should use `pointInTimeRecoverySpecification`) are cosmetic and do not affect functionality.

---

## Coverage Gaps

### Minor Gaps (low risk due to template-based responses)

1. **5-word max clarification constraint**: No test asserts that clarification text never exceeds 5 words. The template "Menade du [activity]?" is inherently short, but a multi-word activity name (e.g., "laga mat och diska") could exceed 5 words. Recommendation: add a test in `response-policy.test.ts` that verifies word count of clarification text, or truncation logic if activity names are long.

2. **<= 1 line output constraint**: No test explicitly validates single-line enforcement. Template-based outputs are single line by design, but there is no programmatic guard. Recommendation: add a test in `response-policy.test.ts` or `tone-validator.test.ts` that rejects text containing newlines.

3. **<= 1 emoji constraint**: No test validates emoji count. "Noterat checkmark" has 1 emoji by design but nothing prevents future changes. Recommendation: add a validation function or test that counts emojis in response text.

4. **15-minute cooldown**: Tested in response-policy but not in the worker integration test. The worker delegates to evaluateResponsePolicy, which is mocked in worker tests. The cooldown logic is verified at the unit level in response-policy tests.

### Integration Gaps (acceptable due to mock boundaries)

5. **End-to-end flow without mocks**: All tests mock their external dependencies (DynamoDB, OpenAI, Telegram, SQS). There are no true integration tests that exercise the full worker pipeline with real service interactions. This is expected for unit test suites and would be covered by a deployment smoke test.

6. **Bot mention detection (`@botUsername`)**: The response-policy tests verify the direct-address path, but the worker test does not pass `botUsername` or `messageText` to evaluateResponsePolicy explicitly. The worker implementation fetches bot info and passes it, but this specific wiring is not asserted.

---

## Summary

- **267/267 tests passing** across 19 test files
- **13/15 PRD success criteria fully covered** by tests
- **2/15 criteria partially covered** (output format constraints: 5-word max, 1-line max, 1-emoji max) -- low risk due to template-based responses
- **0 bugs found**
- Test quality is high: good use of boundary testing, error path coverage, mock isolation, and priority-order verification
