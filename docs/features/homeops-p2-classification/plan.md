# Technical Plan: Message Understanding & Activity Logging

**Feature:** homeops-p2-classification
**PRD:** `/docs/features/homeops-p2-classification/prd.md`
**Research:** `/docs/features/homeops-p2-classification/research/SUMMARY.md`

---

## Decisions Log

| # | Choice | Alternative | Reason |
|---|--------|-------------|--------|
| 1 | Dedicated `homeops-activities` and `homeops-response-counters` tables | Single-table design (existing `homeops` table) | PRD specifies dedicated tables; simpler to reason about and test |
| 2 | Extend existing `MessageStore` construct | New `ActivityStore` construct | User decision — simpler wiring, fewer files; rename not needed |
| 3 | Rolling `gpt-4o-mini` alias | Pinned snapshot (e.g., `gpt-4o-mini-2024-07-18`) | User decision — auto-upgrades; model string stored as configurable constant |
| 4 | ULID seeded with message timestamp | ULID seeded with processing time | Research recommendation — preserves chronological order when SQS is delayed |
| 5 | Templates for clarification text (`"Menade du [activity]?"`) | Model-generated text | Research + PRD — predictable, testable, enforces 5-word limit |
| 6 | Bot `message_id` stored as field on activity item | Separate tracking table or response_counters field | Research — simplest, ties response to triggering activity |
| 7 | Worker timeout 30s → 60s, SQS visibility 180s → 360s | Keep Phase 1 values | Research consensus — accounts for OpenAI + Telegram latency |
| 8 | Worker memory stays at 256 MB | Increase to 512 MB | Research — OpenAI SDK is lightweight; monitor and adjust |
| 9 | `openai` + `zod` + `ulidx` as new deps | Hand-rolled HTTP calls | Research — SDK provides structured output helpers, retry logic, types |
| 10 | Native `fetch` for Telegram API | `telegraf` or `node-telegram-bot-api` | Research — single endpoint (`sendMessage`), zero deps |
| 11 | `Intl.DateTimeFormat` for Stockholm timezone | `date-fns-tz` or `luxon` | Research — zero deps, DST-safe, built-in to Node.js |
| 12 | Keyword blocklist for tone validation | Secondary LLM call | Research gap resolution — responses are short templates; LLM call is overkill |
| 13 | Classify "Ja" (clarification replies) normally via OpenAI | Special bot-reply detection + skip | User decision — "Ja" will likely return `none`; no special logic needed |
| 14 | `lastResponseAt` field on response_counters items | Query activities table for last bot response | Implementation detail — enables 15-minute cooldown check without extra query |

---

## DB Changes

### `homeops-activities` table (new)

| Attribute    | Type   | Key           |
|-------------|--------|---------------|
| chatId      | String | PK            |
| activityId  | String | SK (ULID)     |
| messageId   | Number |               |
| userId      | Number |               |
| userName    | String |               |
| type        | String | `chore` \| `recovery` |
| activity    | String | Swedish name  |
| effort      | String | `low` \| `medium` \| `high` |
| confidence  | Number | 0.0–1.0       |
| timestamp   | Number | Unix ms       |
| createdAt   | String | ISO 8601      |
| botMessageId | Number | Optional — Telegram message_id of bot response |

**GSI:** `userId-timestamp-index` — PK: `userId` (Number), SK: `timestamp` (Number), projection: ALL

- On-demand billing, PITR enabled, RemovalPolicy.DESTROY

### `homeops-response-counters` table (new)

| Attribute      | Type   | Key           |
|---------------|--------|---------------|
| chatId        | String | PK            |
| date          | String | SK (YYYY-MM-DD Stockholm) |
| count         | Number |               |
| lastResponseAt | String | ISO 8601 — last response time in this chat on this date |
| updatedAt     | String | ISO 8601      |
| ttl           | Number | Unix epoch seconds, +7 days |

- On-demand billing, PITR enabled, TTL on `ttl`, RemovalPolicy.DESTROY

### Ingest message body extension

The SQS message body gains two optional fields to support bot-reply detection:

```typescript
interface MessageBody {
  chatId: string;
  messageId: number;
  userId: number;
  userName: string;
  text: string;
  timestamp: number;
  replyToMessageId?: number;  // NEW: reply_to_message.message_id
  replyToIsBot?: boolean;     // NEW: reply_to_message.from.is_bot
}
```

---

## API Contracts

### OpenAI Chat Completions (internal)

**Endpoint:** `POST https://api.openai.com/v1/chat/completions`
**Model:** `gpt-4o-mini`

**System prompt:** English, instructs classification of Swedish household messages. Includes:
- Classification into `chore | recovery | none`
- Confidence bands: `0.95-1.0` (certain), `0.85-0.94` (high), `0.50-0.84` (uncertain), `0.0-0.49` (unlikely)
- Activity name extraction in Swedish
- Effort estimation: `low | medium | high`
- Few-shot examples for common Swedish household phrases

**Structured output schema (Zod → JSON Schema):**

```typescript
const ClassificationSchema = z.object({
  type: z.enum(["chore", "recovery", "none"]),
  activity: z.string().describe("Swedish activity name, empty string if none"),
  effort: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
});
```

**Parameters:** `temperature: 0.2`, `max_completion_tokens: 200`
**Timeout:** 10s client timeout, 1 retry (via SDK)

### Telegram Bot API sendMessage (internal)

**Endpoint:** `POST https://api.telegram.org/bot{token}/sendMessage`

**Request:**
```json
{
  "chat_id": 12345,
  "text": "Noterat ✓",
  "reply_parameters": {
    "message_id": 67890,
    "allow_sending_without_reply": true
  }
}
```

**Response:** `{ "ok": true, "result": { "message_id": 12346, ... } }`

Never retry on failure. Log and continue.

### Telegram Bot API getMe (internal, cached)

**Endpoint:** `GET https://api.telegram.org/bot{token}/getMe`
**Purpose:** Retrieve bot's `id` and `username` for mention detection.
**Caching:** Module-scope, fetched once per Lambda cold start.

---

## Implementation Tasks

### Task 1-test: Classification types, Stockholm timezone, and tone validator tests

- **Type:** test
- **Files:** `test/shared/classification-schema.test.ts`, `test/shared/stockholm-time.test.ts`, `test/shared/tone-validator.test.ts`
- **Dependencies:** none
- **Description:** Write tests for three foundational modules:
  1. **Classification schema** — Validate the Zod schema parses valid classification results `{ type: "chore", activity: "tvätt", effort: "medium", confidence: 0.92 }` and rejects invalid inputs (missing fields, out-of-range confidence, invalid type enum). Test that the Activity interface includes all required fields (chatId, activityId, messageId, userId, userName, type, activity, effort, confidence, timestamp, createdAt, optional botMessageId).
  2. **Stockholm timezone** — `getStockholmDate(date)` returns YYYY-MM-DD in Europe/Stockholm. Test DST transition: 2026-03-29T01:30:00Z → "2026-03-29" (CET→CEST). Test midnight boundary: 2026-02-17T23:30:00Z → "2026-02-18" (Stockholm is UTC+1). `isQuietHours(date)` returns true for 22:00–06:59 Stockholm, false for 07:00–21:59. Test edge cases: exactly 22:00, exactly 07:00, midnight.
  3. **Tone validator** — `validateTone(text)` returns `{ valid: true }` for neutral text ("Noterat", "Menade du tvätt?"). Returns `{ valid: false, reason }` for text containing blame ("du borde"), comparison ("mer än"), commands ("gör detta"), or judgment ("bra jobbat", "dåligt"). Case-insensitive matching.

### Task 1-impl: Classification types, Stockholm timezone, and tone validator

- **Type:** impl
- **Files:** `src/shared/types/classification.ts`, `src/shared/utils/stockholm-time.ts`, `src/shared/utils/tone-validator.ts`
- **Dependencies:** Task 1-test
- **Description:** Install Phase 2 dependencies: `pnpm add openai zod ulidx`. Implement three modules:
  1. **`classification.ts`** — Zod schema `ClassificationSchema` with `z.object({ type, activity, effort, confidence })`. Export inferred type `ClassificationResult`. Export `Activity` interface (chatId, activityId, messageId, userId, userName, type, activity, effort, confidence, timestamp, createdAt, botMessageId?). Export `MessageBody` interface extending Phase 1 fields with optional `replyToMessageId` and `replyToIsBot`.
  2. **`stockholm-time.ts`** — `getStockholmDate(date?: Date): string` using `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' })`. `isQuietHours(date?: Date): boolean` — true for 22:00–06:59 Stockholm.
  3. **`tone-validator.ts`** — `validateTone(text: string): { valid: boolean; reason?: string }`. Swedish keyword blocklist for blame, comparison, commands, judgment patterns.
  Read tests first — make them pass.

### Task 2-test: OpenAI classifier service tests

- **Type:** test
- **Files:** `test/shared/classifier.test.ts`
- **Dependencies:** Task 1-impl
- **Description:** Write tests for the classifier service that calls OpenAI:
  1. Calls `client.beta.chat.completions.parse()` with correct model (`gpt-4o-mini`), temperature (0.2), max_completion_tokens (200), and zodResponseFormat schema.
  2. System prompt is in English and includes Swedish few-shot examples.
  3. Returns parsed `ClassificationResult` on success.
  4. Returns `{ type: "none", activity: "", effort: "low", confidence: 0 }` on OpenAI API error (timeout, 5xx, rate limit) — logs error, does not throw.
  5. Returns `{ type: "none", ... }` when parsing fails (malformed response).
  6. OpenAI client is constructed with the provided API key and 10s timeout.
  Mock the `openai` package using `vi.hoisted()` + `vi.mock()`. Import `ClassificationResult` type from `@shared/types/classification.js`.

### Task 2-impl: OpenAI classifier service

- **Type:** impl
- **Files:** `src/shared/services/classifier.ts`
- **Dependencies:** Task 2-test
- **Description:** Implement `classifyMessage(text: string, apiKey: string): Promise<ClassificationResult>`. Create OpenAI client with API key and 10s timeout. Call `client.beta.chat.completions.parse()` with model `gpt-4o-mini`, temperature 0.2, max_completion_tokens 200. Use `zodResponseFormat(ClassificationSchema, "classification")` for structured output. System prompt in English with Swedish few-shot examples covering common household activities (städa, diska, tvätta, laga mat, dammsuga) and recovery activities (vila, sova, kaffe). Include explicit confidence band definitions. On any error, log and return fallback `{ type: "none", activity: "", effort: "low", confidence: 0 }`. Model string stored as exported constant `CLASSIFICATION_MODEL`.
  Read tests at `test/shared/classifier.test.ts` — make them pass.

### Task 3-test: Activity store service tests

- **Type:** test
- **Files:** `test/shared/activity-store.test.ts`
- **Dependencies:** Task 1-impl
- **Description:** Write tests for the activity store DynamoDB service:
  1. `saveActivity(params)` sends PutItemCommand with correct table name, chatId as PK, activityId as SK (ULID format), and all required attributes.
  2. The activityId ULID is seeded with the message timestamp (not current time).
  3. All DynamoDB attribute types are correct: chatId (S), activityId (S), messageId (N), userId (N), userName (S), type (S), activity (S), effort (S), confidence (N), timestamp (N), createdAt (S).
  4. Optional `botMessageId` is included when provided, omitted when undefined.
  5. Throws on DynamoDB error (caller handles).
  Mock `@aws-sdk/client-dynamodb` using `vi.hoisted()` pattern. Mock `ulidx` to return a predictable ULID.

### Task 3-impl: Activity store service

- **Type:** impl
- **Files:** `src/shared/services/activity-store.ts`
- **Dependencies:** Task 3-test
- **Description:** Implement `saveActivity(params: { tableName: string; chatId: string; messageId: number; userId: number; userName: string; classification: ClassificationResult; timestamp: number; botMessageId?: number }): Promise<string>`. Generate ULID with `ulid(timestamp)` from `ulidx`. Build PutItemCommand with DynamoDB attribute value format. Return the generated activityId. Use module-scope DynamoDBClient singleton. Import Activity type from `@shared/types/classification.js`.
  Read tests at `test/shared/activity-store.test.ts` — make them pass.

### Task 4-test: Response counter service tests

- **Type:** test
- **Files:** `test/shared/response-counter.test.ts`
- **Dependencies:** none
- **Description:** Write tests for the response counter DynamoDB service:
  1. `getResponseCount(tableName, chatId, date)` sends GetItemCommand and returns the count number (0 if item doesn't exist).
  2. `incrementResponseCount(tableName, chatId, date)` sends UpdateItemCommand with `ADD count :inc` expression and sets `updatedAt`, `lastResponseAt`, and `ttl` (7 days from now).
  3. `getLastResponseAt(tableName, chatId, date)` returns ISO string from the item, or null if no item/field exists.
  4. TTL is computed as current time + 7 days in Unix epoch seconds.
  5. Handles DynamoDB errors by throwing (caller handles).
  Mock `@aws-sdk/client-dynamodb` using `vi.hoisted()` pattern. All table name and date parameters are plain strings — no timezone logic tested here.

### Task 4-impl: Response counter service

- **Type:** impl
- **Files:** `src/shared/services/response-counter.ts`
- **Dependencies:** Task 4-test
- **Description:** Implement three functions:
  - `getResponseCount(tableName, chatId, date): Promise<number>` — GetItemCommand, return `count` attribute or 0.
  - `incrementResponseCount(tableName, chatId, date): Promise<void>` — UpdateItemCommand with `SET updatedAt = :now, lastResponseAt = :now, ttl = :ttl ADD count :inc`. The `ADD` expression auto-creates the item if it doesn't exist (upsert).
  - `getLastResponseAt(tableName, chatId, date): Promise<string | null>` — GetItemCommand, return `lastResponseAt` attribute or null.
  Module-scope DynamoDBClient singleton.
  Read tests at `test/shared/response-counter.test.ts` — make them pass.

### Task 5-test: Fast conversation detection tests

- **Type:** test
- **Files:** `test/shared/fast-conversation.test.ts`
- **Dependencies:** none
- **Description:** Write tests for fast conversation detection:
  1. `isConversationFast(tableName, chatId, senderUserId, currentTimestamp)` queries last 10 messages from the messages table using `ScanIndexForward: false`, `Limit: 10`.
  2. Returns `true` if 3+ messages from users OTHER than `senderUserId` arrived within the last 60 seconds (comparing `timestamp` attributes).
  3. Returns `false` if fewer than 3 messages from others in last 60s.
  4. Returns `false` if the table query returns no items.
  5. Correctly filters out messages from `senderUserId` (the message sender, not the bot).
  Mock `@aws-sdk/client-dynamodb` using `vi.hoisted()` pattern. Test with various message timestamp distributions.

### Task 5-impl: Fast conversation detection

- **Type:** impl
- **Files:** `src/shared/services/fast-conversation.ts`
- **Dependencies:** Task 5-test
- **Description:** Implement `isConversationFast(tableName: string, chatId: string, senderUserId: number, currentTimestamp: number): Promise<boolean>`. QueryCommand on messages table: PK = chatId, `ScanIndexForward: false`, `Limit: 10`. Filter results in application code: count messages where `userId !== senderUserId` and `timestamp >= currentTimestamp - 60`. Return true if count >= 3. Module-scope DynamoDBClient singleton.
  Read tests at `test/shared/fast-conversation.test.ts` — make them pass.

### Task 6-test: Telegram sender service tests

- **Type:** test
- **Files:** `test/shared/telegram-sender.test.ts`
- **Dependencies:** none
- **Description:** Write tests for the Telegram sender service:
  1. `sendMessage(params)` calls `fetch` with correct URL (`https://api.telegram.org/bot{token}/sendMessage`), method POST, JSON body with `chat_id`, `text`, and `reply_parameters` (using `message_id` and `allow_sending_without_reply: true`).
  2. Returns `{ ok: true, messageId: number }` on success (extracts `result.message_id` from Telegram response).
  3. Returns `{ ok: false, error: string }` on HTTP error — logs error, does NOT throw.
  4. Returns `{ ok: false, error: string }` on network error — logs error, does NOT throw.
  5. `getBotInfo(token)` calls `getMe` endpoint and returns `{ id: number, username: string }`.
  6. `getBotInfo` caches result at module scope — second call does not fetch.
  Mock `global.fetch` using `vi.fn()`.

### Task 6-impl: Telegram sender service

- **Type:** impl
- **Files:** `src/shared/services/telegram-sender.ts`
- **Dependencies:** Task 6-test
- **Description:** Implement:
  - `sendMessage(params: { token: string; chatId: number; text: string; replyToMessageId: number }): Promise<{ ok: boolean; messageId?: number; error?: string }>`. Uses native `fetch` with `reply_parameters` (NOT deprecated `reply_to_message_id`). On failure: log error, return `{ ok: false, error }`. Never throw.
  - `getBotInfo(token: string): Promise<{ id: number; username: string }>`. Calls `getMe`, caches at module scope. Returns cached result on subsequent calls.
  Read tests at `test/shared/telegram-sender.test.ts` — make them pass.

### Task 7-test: Response policy engine tests

- **Type:** test
- **Files:** `test/shared/response-policy.test.ts`
- **Dependencies:** Task 1-impl
- **Description:** Write tests for the response policy engine that decides whether the bot should respond. The engine receives classification result + context and returns a response decision.
  1. Returns `{ respond: false, reason: "none" }` when classification type is `none`.
  2. Returns `{ respond: true, text: "Noterat ✓" }` when confidence >= 0.85 and all silence checks pass.
  3. Returns `{ respond: true, text: "Menade du [activity]?" }` when confidence is 0.50–0.84 (clarification).
  4. Returns `{ respond: false, reason: "quiet_hours" }` during 22:00–07:00 Stockholm.
  5. Returns `{ respond: false, reason: "daily_cap" }` when count >= 3.
  6. Returns `{ respond: false, reason: "fast_conversation" }` when conversation is fast-moving.
  7. Returns `{ respond: false, reason: "cooldown" }` when last response was within 15 minutes.
  8. Returns `{ respond: false, reason: "low_confidence" }` when confidence < 0.50.
  9. Returns `{ respond: true, text }` when directly addressed (message mentions bot name), regardless of confidence (but still respects silence rules).
  10. Returns `{ respond: false, reason: "tone" }` if generated text fails tone validation — message suppressed.
  11. Silence rules are checked in order: type=none → quiet hours → daily cap → fast conversation → cooldown → confidence threshold.
  Mock all dependency functions (`isQuietHours`, `getResponseCount`, `getLastResponseAt`, `isConversationFast`, `validateTone`) using `vi.mock()`. Import types from `@shared/types/classification.js`.

### Task 7-impl: Response policy engine

- **Type:** impl
- **Files:** `src/shared/services/response-policy.ts`
- **Dependencies:** Task 7-test, Task 4-impl, Task 5-impl
- **Description:** Implement `evaluateResponsePolicy(params: { classification: ClassificationResult; chatId: string; senderUserId: number; currentTimestamp: number; messagesTableName: string; countersTableName: string; botUsername?: string; messageText?: string }): Promise<{ respond: boolean; text?: string; reason?: string }>`.
  Check silence rules in order:
  1. `type === "none"` → silent
  2. `isQuietHours()` → silent
  3. `getResponseCount() >= 3` → silent
  4. `isConversationFast()` → silent
  5. `getLastResponseAt()` within 15 minutes → silent
  6. If directly addressed (text contains `@botUsername`): generate appropriate response text
  7. If confidence >= 0.85: generate acknowledgment (`"Noterat ✓"`)
  8. If confidence 0.50–0.84: generate clarification (`"Menade du [activity]?"`)
  9. If confidence < 0.50: silent
  10. Validate tone of response text → if invalid, suppress
  Export constants: `CONFIDENCE_HIGH = 0.85`, `CONFIDENCE_CLARIFY = 0.50`, `DAILY_CAP = 3`, `COOLDOWN_MINUTES = 15`.
  Read tests at `test/shared/response-policy.test.ts` — make them pass.

### Task 8-test: CDK MessageStore extension tests

- **Type:** test
- **Files:** `test/infra/message-store.test.ts` (modify)
- **Dependencies:** none
- **Description:** Add CDK assertion tests to the existing MessageStore test file for two new tables:
  1. `homeops-activities` table: PK `chatId` (S), SK `activityId` (S), on-demand billing, PITR enabled, RemovalPolicy.DESTROY. Has GSI `userId-timestamp-index` with PK `userId` (N) and SK `timestamp` (N).
  2. `homeops-response-counters` table: PK `chatId` (S), SK `date` (S), on-demand billing, PITR enabled, TTL on `ttl` attribute, RemovalPolicy.DESTROY.
  3. Total DynamoDB tables in MessageStore: 4 (messages, homeops, activities, response-counters).
  4. MessageStore exposes `activitiesTable` and `responseCountersTable` as public properties.
  Read existing tests at `test/infra/message-store.test.ts` to follow the established assertion patterns.

### Task 8-impl: CDK MessageStore extension

- **Type:** impl
- **Files:** `infra/constructs/message-store.ts` (modify)
- **Dependencies:** Task 8-test
- **Description:** Extend the MessageStore construct to add two new tables:
  1. `homeops-activities`: partitionKey `chatId` (STRING), sortKey `activityId` (STRING), on-demand, PITR, DESTROY. Add GSI `userId-timestamp-index` with partitionKey `userId` (NUMBER) and sortKey `timestamp` (NUMBER).
  2. `homeops-response-counters`: partitionKey `chatId` (STRING), sortKey `date` (STRING), on-demand, PITR, TTL on `ttl`, DESTROY.
  Export both as `public readonly activitiesTable` and `public readonly responseCountersTable`.
  Read existing code at `infra/constructs/message-store.ts` and tests at `test/infra/message-store.test.ts` — make tests pass.

### Task 9-test: CDK MessageProcessing and Stack wiring tests

- **Type:** test
- **Files:** `test/infra/message-processing.test.ts` (modify), `test/infra/stack.test.ts` (modify)
- **Dependencies:** Task 8-impl
- **Description:** Add CDK assertion tests for Phase 2 infrastructure wiring:
  **MessageProcessing tests:**
  1. Worker Lambda timeout is 60s (was 30s).
  2. SQS queue visibility timeout is 360s (was 180s).
  3. Worker Lambda has new environment variables: `ACTIVITIES_TABLE_NAME`, `RESPONSE_COUNTERS_TABLE_NAME`, `OPENAI_API_KEY_ARN`, `TELEGRAM_BOT_TOKEN_ARN`, `MESSAGES_TABLE_NAME` (existing).
  4. Worker Lambda IAM role has `dynamodb:PutItem` on activities table.
  5. Worker Lambda IAM role has `dynamodb:GetItem` and `dynamodb:UpdateItem` on response-counters table.
  6. Worker Lambda IAM role has `dynamodb:Query` on messages table (for fast conversation detection).
  7. Worker Lambda IAM role has `secretsmanager:GetSecretValue` on OpenAI key and Telegram bot token secrets.
  **Stack tests:**
  8. Stack contains 4 DynamoDB tables (messages, homeops, activities, response-counters).
  9. Stack still has 3 Secrets Manager secrets (unchanged).
  Read existing tests to follow established patterns. The MessageProcessing construct now accepts additional props.

### Task 9-impl: CDK MessageProcessing and Stack wiring

- **Type:** impl
- **Files:** `infra/constructs/message-processing.ts` (modify), `infra/stack.ts` (modify), `infra/config.ts` (modify)
- **Dependencies:** Task 9-test
- **Description:** Extend CDK infrastructure for Phase 2:
  **message-processing.ts:**
  1. Extend `MessageProcessingProps` to accept `activitiesTable`, `responseCountersTable`, `messagesTable`, `openaiApiKeySecret`, `telegramBotTokenSecret`.
  2. Change Worker timeout from 30s to 60s.
  3. Change queue visibility timeout from 180s to 360s.
  4. Add environment variables: `ACTIVITIES_TABLE_NAME`, `RESPONSE_COUNTERS_TABLE_NAME`, `OPENAI_API_KEY_ARN`, `TELEGRAM_BOT_TOKEN_ARN`.
  5. Grant Worker: `dynamodb:PutItem` on activities table, `dynamodb:GetItem` + `dynamodb:UpdateItem` on response-counters, `dynamodb:Query` on messages table, `secretsmanager:GetSecretValue` on both secrets.
  **stack.ts:**
  6. Pass new tables and secrets from MessageStore/stack to MessageProcessing props.
  7. Assign secret references to local variables for passing (`botTokenSecret`, `openaiApiKeySecret`).
  **config.ts:**
  8. Add `activitiesTableName` and `responseCountersTableName` constants.
  Read tests first — make them pass.

### Task 10-test: Ingest Lambda reply metadata tests

- **Type:** test
- **Files:** `test/handlers/ingest.test.ts` (modify)
- **Dependencies:** none
- **Description:** Add tests to the existing ingest handler test file for reply metadata extraction:
  1. When Telegram update has `message.reply_to_message`, the SQS message body includes `replyToMessageId` (from `reply_to_message.message_id`) and `replyToIsBot` (from `reply_to_message.from.is_bot`).
  2. When there is no `reply_to_message`, the SQS body does NOT include `replyToMessageId` or `replyToIsBot` fields.
  3. When `reply_to_message` exists but has no `from` field, `replyToIsBot` defaults to `false`.
  Read existing tests at `test/handlers/ingest.test.ts` to follow established mock patterns and event structure.

### Task 10-impl: Ingest Lambda reply metadata

- **Type:** impl
- **Files:** `src/handlers/ingest/index.ts` (modify), `src/shared/types/telegram.ts` (modify)
- **Dependencies:** Task 10-test
- **Description:** Extend the ingest Lambda to pass reply metadata through SQS:
  1. In `telegram.ts`: Add `reply_to_message?: TelegramMessage` field to the `TelegramMessage` interface.
  2. In `ingest/index.ts`: After extracting message fields, conditionally add `replyToMessageId` and `replyToIsBot` to the SQS message body if `message.reply_to_message` exists.
  Read tests first — make them pass. Keep changes minimal — only add the two new fields.

### Task 11-test: Worker Lambda classification pipeline tests

- **Type:** test
- **Files:** `test/handlers/worker.test.ts` (modify)
- **Dependencies:** Task 1-impl
- **Description:** Add comprehensive tests to the existing worker handler test file for the Phase 2 classification pipeline. Mock all service modules using `vi.mock()`:
  - `@shared/services/classifier.js` → `classifyMessage`
  - `@shared/services/activity-store.js` → `saveActivity`
  - `@shared/services/response-counter.js` → `getResponseCount`, `incrementResponseCount`, `getLastResponseAt`
  - `@shared/services/fast-conversation.js` → `isConversationFast`
  - `@shared/services/telegram-sender.js` → `sendMessage`, `getBotInfo`
  - `@shared/services/response-policy.js` → `evaluateResponsePolicy`
  - `@shared/utils/secrets.js` → `getSecret`

  **Test cases:**
  1. After successful DynamoDB write, calls `classifyMessage` with message text and OpenAI API key.
  2. When classification returns `chore`/`recovery`, calls `saveActivity` with correct params.
  3. When classification returns `none`, does NOT call `saveActivity` or `evaluateResponsePolicy`.
  4. When classification succeeds, calls `evaluateResponsePolicy` with classification result and context.
  5. When response policy returns `{ respond: true }`, calls `sendMessage` with the response text.
  6. When response policy returns `{ respond: false }`, does NOT call `sendMessage`.
  7. After successful Telegram send, calls `incrementResponseCount` and updates activity with `botMessageId`.
  8. When OpenAI classification fails (returns fallback none), processing continues without error.
  9. When Telegram send fails, processing continues — error logged, no throw.
  10. When activity store write fails, processing continues — error logged, no throw.
  11. Existing Phase 1 tests continue to pass (DynamoDB raw message storage, idempotency).
  12. Worker reads `OPENAI_API_KEY_ARN` and `TELEGRAM_BOT_TOKEN_ARN` env vars and fetches secrets.

### Task 11-impl: Worker Lambda classification pipeline

- **Type:** impl
- **Files:** `src/handlers/worker/index.ts` (modify)
- **Dependencies:** Task 11-test, Task 2-impl, Task 3-impl, Task 7-impl, Task 6-impl
- **Description:** Extend the Worker Lambda handler to add classification, activity logging, and response logic AFTER the existing DynamoDB raw message write. The pipeline:
  1. **Existing:** Parse SQS record, write raw message to DynamoDB (unchanged).
  2. **NEW — Classify:** Fetch OpenAI API key from Secrets Manager (using `getSecret`). Call `classifyMessage(text, apiKey)`. Wrap in try-catch — on failure, log and continue.
  3. **NEW — Check type:** If classification `type === "none"`, skip to next record.
  4. **NEW — Store activity:** Call `saveActivity(...)` with classification result. Wrap in try-catch.
  5. **NEW — Evaluate policy:** Call `evaluateResponsePolicy(...)` with classification, chatId, userId, timestamp, table names, bot username. Wrap in try-catch.
  6. **NEW — Respond:** If policy says respond, fetch Telegram bot token from Secrets Manager, call `sendMessage(...)`. On success: call `incrementResponseCount(...)` and update activity with `botMessageId`. Wrap in try-catch.
  Import `MessageBody` from `@shared/types/classification.js`. Replace the local `MessageBody` interface. All new external calls wrapped in try-catch that log errors and continue — only the DynamoDB raw message write may throw (triggering SQS retry).
  Read tests first — make them pass.

---

## Execution Waves

```
Wave 1: Task 1-test, Task 4-test, Task 5-test, Task 6-test, Task 8-test, Task 10-test
         (All independent test tasks — no external dependencies)

Wave 2: Task 1-impl, Task 4-impl, Task 5-impl, Task 6-impl, Task 8-impl, Task 10-impl
         (Each depends only on its own test task from Wave 1)

Wave 3: Task 2-test, Task 3-test, Task 7-test, Task 9-test, Task 11-test
         (Need Task 1-impl for classification types. Task 9-test needs Task 8-impl for CDK table refs.)

Wave 4: Task 2-impl, Task 3-impl, Task 7-impl, Task 9-impl
         (Task 7-impl needs Task 4-impl + Task 5-impl from Wave 2.
          Task 9-impl needs Task 8-impl from Wave 2.)

Wave 5: Task 11-impl
         (Needs all service impls from Waves 2 + 4, plus Task 10-impl from Wave 2.)
```

**Critical path:** 1-test → 1-impl → 7-test → 7-impl → 11-impl (5 waves)

**Maximum parallelism per wave:** 6 tasks (Waves 1–2)

---

## Context Budget Check

- [x] No task touches more than 5 files (max: Task 1-test with 3 files, Task 9-impl with 3 files)
- [x] Each task description is under 20 lines
- [x] Each task can be understood without reading the full plan
- [x] Dependencies are explicit — no implicit ordering
- [x] Every impl task depends on its corresponding test task
- [x] No test task depends on its own impl task
