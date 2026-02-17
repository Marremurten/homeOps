# Technical Plan: Memory System & Learning

**Feature:** homeops-p3-learning
**PRD:** `/docs/features/homeops-p3-learning/prd.md`
**Research:** `/docs/features/homeops-p3-learning/research/SUMMARY.md`

---

## Decisions Log

| # | Choice | Alternative | Reason |
|---|--------|-------------|--------|
| 1 | Derive active hours from PATTERN `hourOfDayCounts` | Separate PREF record with decaying counters | User decision — simpler, avoids duplication; add recency weighting later if needed |
| 2 | Check ignore rate on user's next message | EventBridge scheduled check per bot response | User decision — simple, no new infra; good enough at household scale with 10-data-point minimum |
| 3 | Classifier's activity name as alias key | User's original phrasing | User decision — simpler and consistent; revisit if matching proves too narrow |
| 4 | Skip zero-activity days in interaction frequency EMA | Daily scheduled Lambda to close day counts | User decision — no extra infra; adjust threshold if needed |
| 5 | Keep CONFIDENCE_CLARIFY at 0.50 | Lower to 0.40 for more learning opportunities | User decision — observe alias learning effectiveness first |
| 6 | DM welcome: "Tack! Du kan nu ta emot personliga uppdateringar från mig." | Custom text | User decision |
| 7 | Existing `homeops` table for all new record types | New tables per record type | PRD + research consensus — single-table design with PK/SK is sufficient |
| 8 | New `chatId-activity-index` GSI on activities table | Query without GSI | Research — enables "who did X last?" without knowing userId |
| 9 | Hybrid clarification detection (rule-based + OpenAI) | Pure OpenAI or pure rule-based | Research — rules handle ~80% at zero cost; OpenAI only for corrections |
| 10 | Lambda in-memory cache (5-min TTL) for aliases | Query on every message | Research — household has 20-100 aliases; one query per cold start |
| 11 | Read-modify-write for patterns; optimistic locking for EMA | Atomic DynamoDB expressions | Research — DynamoDB can't do multiplication; pattern counters tolerate lost increments |
| 12 | Interaction frequency via EMA (α=0.2) | Rolling 7-day window | Research — simpler storage (one number vs seven counters) |
| 13 | Reactive 403 detection for DM blocking | `my_chat_member` webhook | Research — deferred to Phase 5-6 |

---

## DB Changes

### New GSI on `homeops-activities` table

| Attribute | Type | Key |
|-----------|------|-----|
| chatId | String | GSI PK |
| activityTimestamp | String | GSI SK (`<activity>#<timestamp>`) |

- Index name: `chatId-activity-index`
- Projection: ALL

### New attribute on activity items

| Attribute | Format | Purpose |
|-----------|--------|---------|
| activityTimestamp | `<activity>#<timestamp>` | Composite sort key for GSI — enables `begins_with(activity#)` queries |

Only populated on new writes. Old items lack this attribute and are not returned by the GSI.

### New record types in `homeops` table (existing PK/SK/GSI1)

All use the existing `homeops` table. No schema changes — just new PK/SK patterns:

- **Alias**: PK `ALIAS#<chatId>`, SK `<normalizedAlias>`, GSI1PK `ALIASES_BY_ACTIVITY#<chatId>`, GSI1SK `<canonicalActivity>`
- **Effort EMA**: PK `EFFORT#<userId>`, SK `<canonicalActivity>`
- **Preference**: PK `PREF#<userId>`, SK `ignoreRate` | `interactionFrequency`
- **Pattern Habit**: PK `PATTERN#<chatId>#<userId>`, SK `<canonicalActivity>`
- **DM Status**: PK `DM#<userId>`, SK `STATUS`

Field details are in the PRD § DynamoDB Record Design.

### Ingest message body extension

Two new fields on the SQS message body:

```typescript
interface MessageBody {
  // ... existing fields ...
  chatType?: "private" | "group" | "supergroup";  // NEW
  replyToText?: string;                             // NEW
}
```

---

## API Contracts

### OpenAI Classification (modified)

The system prompt gains two optional context sections appended dynamically:

```
[existing system prompt unchanged]

{if aliases exist for this chat}
Vocabulary context for this household:
- "pant" means "pantning"
- "dammsuga" means "dammsugning"
{end}

{if effort EMA exists for this user + activity}
Historical effort context:
- This user's typical effort for "diskning" is medium (EMA: 2.1)
{end}
```

No changes to model, temperature, max_tokens, or response schema.

### OpenAI Correction Extraction (new usage of existing endpoint)

When a corrective clarification reply is detected (e.g., "nej, jag menade tvätt"), the correction text (after stripping negation prefix) is sent through the existing `classifyMessage` function. If confidence >= 0.70, the classified activity becomes the alias target.

### Telegram sendMessage (modified)

`reply_parameters` is now optional. When `replyToMessageId` is omitted (e.g., proactive DM), `reply_parameters` is not included in the request body.

---

## Implementation Tasks

### Task 1-test: Seed aliases, Swedish patterns, and type extension tests

- **Type:** test
- **Files:** `test/shared/seed-aliases.test.ts`, `test/shared/swedish-patterns.test.ts`
- **Dependencies:** none
- **Description:** Write tests for two new data modules:
  1. **Seed aliases** — `SEED_ALIASES` is a `Record<string, string>` mapping informal/short Swedish terms to canonical activity names. Must include at least: "pant" → "pantning", "dammsuga" → "dammsugning", "disk" → "diskning", "tvätt" → "tvättning", "städ" → "städning". All keys are lowercase. All values are non-empty strings.
  2. **Swedish patterns** — `AFFIRMATIVE_PATTERNS` is a RegExp that matches Swedish affirmative words: "ja", "japp", "jepp", "jo", "precis", "absolut", "aa", "mm", "okej", "jadå" (case-insensitive, full-word match). `NEGATION_PATTERNS` is a RegExp matching: "nej", "nä", "nää", "nix", "nope" (NOT "nahå", "nåmen"). `extractNegationRemainder(text)` returns the text after the negation prefix (e.g., "nej, jag menade tvätt" → "jag menade tvätt"). Returns null if no negation prefix found.

### Task 1-impl: Seed aliases, Swedish patterns, and type extension

- **Type:** impl
- **Files:** `src/shared/data/seed-aliases.ts`, `src/shared/data/swedish-patterns.ts`, `src/shared/types/classification.ts` (modify)
- **Dependencies:** Task 1-test
- **Description:** Implement:
  1. **`seed-aliases.ts`** — Export `SEED_ALIASES: Record<string, string>` with common Swedish household alias mappings.
  2. **`swedish-patterns.ts`** — Export `AFFIRMATIVE_PATTERNS` (RegExp), `NEGATION_PATTERNS` (RegExp), and `extractNegationRemainder(text: string): string | null`.
  3. **`classification.ts`** — Add to `MessageBody` interface: `chatType?: "private" | "group" | "supergroup"` and `replyToText?: string`.
  Read tests first — make them pass.

### Task 2-test: Alias store and alias resolver tests

- **Type:** test
- **Files:** `test/shared/alias-store.test.ts`, `test/shared/alias-resolver.test.ts`
- **Dependencies:** none
- **Description:** Write tests for two alias services:
  1. **Alias store** — `getAliasesForChat(tableName, chatId)` sends QueryCommand with PK `ALIAS#<chatId>` and returns array of `{ alias: string, canonicalActivity: string, confirmations: number, source: "seed" | "learned" }`. `putAlias(tableName, params)` sends PutItemCommand with correct PK/SK/GSI1 attributes. `incrementConfirmation(tableName, chatId, alias)` sends UpdateItemCommand with `ADD confirmations :inc`. `deleteAlias(tableName, chatId, alias)` sends DeleteItemCommand.
  2. **Alias resolver** — `resolveAliases(tableName, chatId, text)` returns `{ resolvedText: string, appliedAliases: Array<{ alias: string, canonicalActivity: string }> }`. Uses cached aliases (5-min TTL). First call queries DynamoDB; second call within TTL does NOT query. After TTL expires, re-queries. Merges seed aliases with learned aliases (learned takes precedence). Matches alias words in text (case-insensitive, word-boundary).
  Mock `@aws-sdk/client-dynamodb` using `vi.hoisted()` pattern.

### Task 2-impl: Alias store and alias resolver

- **Type:** impl
- **Files:** `src/shared/services/alias-store.ts`, `src/shared/services/alias-resolver.ts`
- **Dependencies:** Task 2-test, Task 1-impl
- **Description:** Implement:
  1. **`alias-store.ts`** — CRUD for alias records in the `homeops` table. `getAliasesForChat` uses QueryCommand with `pk = ALIAS#<chatId>`. `putAlias` writes PK, SK (normalized alias), canonicalActivity, confirmations, source, gsi1pk (`ALIASES_BY_ACTIVITY#<chatId>`), gsi1sk (canonicalActivity), timestamps. `incrementConfirmation` uses UpdateItemCommand with `ADD`. `deleteAlias` uses DeleteItemCommand.
  2. **`alias-resolver.ts`** — Module-scope cache (`Map<string, { aliases, fetchedAt }>`). `resolveAliases` checks cache first (5-min TTL). On miss, calls `getAliasesForChat` and merges with `SEED_ALIASES` (learned aliases override seeds). Scans text for alias matches (word-boundary, case-insensitive). Returns resolved text and applied aliases list.
  Read tests first — make them pass.

### Task 3-test: Effort tracker and pattern tracker tests

- **Type:** test
- **Files:** `test/shared/effort-tracker.test.ts`, `test/shared/pattern-tracker.test.ts`
- **Dependencies:** none
- **Description:** Write tests for two tracker services:
  1. **Effort tracker** — `getEffortEma(tableName, userId, activity)` returns `{ ema: number, sampleCount: number } | null` (null if no record). `updateEffortEma(tableName, userId, activity, effort)` computes EMA: cold start (sampleCount 0) sets ema = effort value; subsequent updates use `EMA_new = α × current + (1 - α) × previous` with α from `EMA_ALPHA` env var (default 0.3). Effort values: low=1, medium=2, high=3. EMA rounded to 4 decimal places. Uses optimistic locking: PutItemCommand with `ConditionExpression: sampleCount = :expected` (or `attribute_not_exists(pk)` for new items). On ConditionalCheckFailedException, logs warning and returns without error.
  2. **Pattern tracker** — `updatePatternHabit(tableName, chatId, userId, activity, timestamp)` increments day-of-week and hour-of-day counters. Uses read-modify-write: GetItem, increment counters in-memory, PutItem. Day keys: "mon"-"sun". Hour keys: "0"-"23". `totalCount` incremented. `lastSeen` updated to ISO 8601. New item: initializes all counters to 0, sets the relevant day/hour to 1. `getPatternHabit(tableName, chatId, userId, activity)` returns the record or null.
  Mock `@aws-sdk/client-dynamodb` using `vi.hoisted()` pattern.

### Task 3-impl: Effort tracker and pattern tracker

- **Type:** impl
- **Files:** `src/shared/services/effort-tracker.ts`, `src/shared/services/pattern-tracker.ts`
- **Dependencies:** Task 3-test
- **Description:** Implement:
  1. **`effort-tracker.ts`** — `EFFORT_VALUES` map: `{ low: 1, medium: 2, high: 3 }`. Read α from `process.env.EMA_ALPHA` (default "0.3"). `getEffortEma` uses GetItemCommand with PK `EFFORT#<userId>`, SK `<activity>`. `updateEffortEma` reads current, computes new EMA, writes with optimistic lock on sampleCount. Rounds to 4 decimal places via `Math.round(ema * 10000) / 10000`. Catches ConditionalCheckFailedException and logs warning.
  2. **`pattern-tracker.ts`** — PK `PATTERN#<chatId>#<userId>`, SK `<activity>`. `updatePatternHabit` reads item, increments the correct day-of-week (from timestamp via Stockholm timezone) and hour-of-day counters, increments totalCount, writes back. Uses `Intl.DateTimeFormat` for Stockholm day/hour extraction.
  Read tests first — make them pass.

### Task 4-test: Preference tracker tests

- **Type:** test
- **Files:** `test/shared/preference-tracker.test.ts`
- **Dependencies:** none
- **Description:** Write tests for the preference tracker service:
  1. `updateIgnoreRate(tableName, userId, ignored)` computes EMA on binary (ignored=true → 1, false → 0) with α=0.2 (from `EMA_ALPHA_IGNORE` env var). Cold start: first value becomes initial rate. Uses optimistic locking on sampleCount. Rounds to 4 decimal places.
  2. `getIgnoreRate(tableName, userId)` returns `{ rate: number, sampleCount: number } | null`.
  3. `updateInteractionFrequency(tableName, userId, messageCount)` computes EMA on daily message count with α=0.2. Called once per day on user's first message. PK `PREF#<userId>`, SK `interactionFrequency`. Includes `lastDate` field (Stockholm date string) to detect day boundaries.
  4. `getInteractionFrequency(tableName, userId)` returns `{ frequency: number, sampleCount: number } | null`.
  Mock `@aws-sdk/client-dynamodb` using `vi.hoisted()` pattern.

### Task 4-impl: Preference tracker

- **Type:** impl
- **Files:** `src/shared/services/preference-tracker.ts`
- **Dependencies:** Task 4-test
- **Description:** Implement preference tracking with two metrics:
  1. **Ignore rate** — PK `PREF#<userId>`, SK `ignoreRate`. Same EMA pattern as effort tracker but α from `EMA_ALPHA_IGNORE` env var (default "0.2"). Binary input: ignored=true → 1.0, false → 0.0.
  2. **Interaction frequency** — PK `PREF#<userId>`, SK `interactionFrequency`. On each call, check `lastDate` field. If same Stockholm date, skip (already counted today). If different date, compute EMA with current day's message count. Store `lastDate`, `todayCount`, `frequency` (EMA), `sampleCount`.
  Both use optimistic locking on sampleCount. Both round to 4 decimal places.
  Read tests first — make them pass.

### Task 5-test: DM status and channel router tests

- **Type:** test
- **Files:** `test/shared/dm-status.test.ts`, `test/shared/channel-router.test.ts`
- **Dependencies:** none
- **Description:** Write tests for two services:
  1. **DM status** — `getDmStatus(tableName, userId)` returns `{ optedIn: boolean, privateChatId?: number } | null` (null if no record). Uses PK `DM#<userId>`, SK `STATUS`. `setDmOptedIn(tableName, userId, privateChatId)` writes record with `optedIn: true`, `privateChatId`, `optedInAt` timestamp. `markPrompted(tableName, userId)` sets a `prompted: true` flag on existing record (UpdateItemCommand).
  2. **Channel router** — `routeResponse(params)` is a pure function. Params: `{ contentType: "acknowledgment" | "clarification" | "adaptation_hint" | "query_result", isDmOptedIn: boolean, chatType: "private" | "group" | "supergroup" }`. Returns `"group"` for acknowledgments and clarifications in group chats. Returns `"dm"` for adaptation hints when DM opted in. Returns `"none"` for adaptation hints when not opted in. Returns `"group"` for query results in group. Private chat messages always return `"dm"`.
  Mock `@aws-sdk/client-dynamodb` for DM status tests.

### Task 5-impl: DM status and channel router

- **Type:** impl
- **Files:** `src/shared/services/dm-status.ts`, `src/shared/services/channel-router.ts`
- **Dependencies:** Task 5-test
- **Description:** Implement:
  1. **`dm-status.ts`** — CRUD for DM status records. PK `DM#<userId>`, SK `STATUS`. GetItem for reads, PutItem for opt-in, UpdateItem for markPrompted.
  2. **`channel-router.ts`** — Pure function with no DynamoDB calls. Routes based on content type, DM opt-in, and chat type. Adaptation hints go to DM only if opted in; otherwise suppressed.
  Read tests first — make them pass.

### Task 6-test: Memory query service tests

- **Type:** test
- **Files:** `test/shared/memory-query.test.ts`
- **Dependencies:** none
- **Description:** Write tests for three query functions:
  1. `queryLastActivity(activitiesTableName, chatId, activity)` queries `chatId-activity-index` GSI with PK `chatId` and SK `begins_with(<activity>#)`, `ScanIndexForward: false`, `Limit: 1`. Returns `{ userId: number, userName: string, activity: string, timestamp: number } | null`.
  2. `queryUserActivity(activitiesTableName, userId, activity, sinceTimestamp)` queries `userId-timestamp-index` GSI with PK `userId`, SK `>= sinceTimestamp`, and filters by activity name. Returns array of activity records.
  3. `queryActivityCount(activitiesTableName, userId, activity, sinceTimestamp)` same query as above but returns count only.
  Mock `@aws-sdk/client-dynamodb` using `vi.hoisted()` pattern.

### Task 6-impl: Memory query service

- **Type:** impl
- **Files:** `src/shared/services/memory-query.ts`
- **Dependencies:** Task 6-test
- **Description:** Implement three DynamoDB query functions. `queryLastActivity` uses the new `chatId-activity-index` GSI with `begins_with` on `activityTimestamp`. `queryUserActivity` uses existing `userId-timestamp-index` GSI with `FilterExpression` on activity. `queryActivityCount` reuses the same query but only returns the count. Module-scope DynamoDBClient singleton.
  Read tests first — make them pass.

### Task 7-test: Clarification handler tests

- **Type:** test
- **Files:** `test/shared/clarification-handler.test.ts`
- **Dependencies:** Task 1-impl, Task 2-impl
- **Description:** Write tests for `handleClarificationReply(params)` where params include `{ tableName, chatId, userId, replyToText, userReplyText, apiKey }`. `replyToText` is the bot's original message (e.g., "Menade du diskning?").
  1. Extracts suggested activity from bot text via regex (`/Menade du (.+)\?/`).
  2. **Affirmative reply** (e.g., "ja", "mm"): calls `putAlias` with the suggested activity as canonicalActivity. If alias already exists, calls `incrementConfirmation`. Returns `{ handled: true, action: "confirmed", activity }`.
  3. **Corrective reply** (e.g., "nej, jag menade tvätt"): strips negation prefix via `extractNegationRemainder`, classifies remainder via `classifyMessage`. If confidence >= 0.70, creates alias with classifier's activity. Returns `{ handled: true, action: "corrected", activity }`.
  4. **Low-confidence correction** (classifier returns < 0.70): returns `{ handled: false, reason: "low_confidence" }`.
  5. **Ambiguous reply** (not affirmative, not negation): returns `{ handled: false, reason: "ambiguous" }`.
  6. **Non-clarification bot message** (replyToText doesn't match pattern): returns `{ handled: false, reason: "not_clarification" }`.
  Mock `@shared/services/alias-store.js`, `@shared/services/classifier.js`, and `@shared/data/swedish-patterns.js` using `vi.mock()`.

### Task 7-impl: Clarification handler

- **Type:** impl
- **Files:** `src/shared/services/clarification-handler.ts`
- **Dependencies:** Task 7-test, Task 1-impl, Task 2-impl
- **Description:** Implement `handleClarificationReply`. Extract suggested activity from bot text. Check if user reply is affirmative (via `AFFIRMATIVE_PATTERNS`), negation (via `NEGATION_PATTERNS` + `extractNegationRemainder`), or ambiguous. For affirmatives: create/confirm alias via `putAlias`/`incrementConfirmation`. For corrections: classify remainder via `classifyMessage`; if confidence >= 0.70, create alias. Import from `@shared/data/swedish-patterns.js` and `@shared/services/alias-store.js`.
  Read tests first — make them pass.

### Task 8-test: Telegram sender and activity store extension tests

- **Type:** test
- **Files:** `test/shared/telegram-sender.test.ts` (modify), `test/shared/activity-store.test.ts` (modify)
- **Dependencies:** none
- **Description:** Add tests to existing test files:
  1. **Telegram sender** — When `replyToMessageId` is undefined, the request body does NOT include `reply_parameters`. When `replyToMessageId` is provided, behavior is unchanged (includes `reply_parameters`).
  2. **Activity store** — `saveActivity` now populates an `activityTimestamp` attribute with format `<activity>#<timestamp>` (e.g., `diskning#1708200000`). Verify the PutItemCommand includes this new attribute. Existing tests continue to pass.
  Read existing tests to follow established patterns.

### Task 8-impl: Telegram sender and activity store extensions

- **Type:** impl
- **Files:** `src/shared/services/telegram-sender.ts` (modify), `src/shared/services/activity-store.ts` (modify)
- **Dependencies:** Task 8-test
- **Description:** Modify two services:
  1. **`telegram-sender.ts`** — Make `replyToMessageId` optional in `SendMessageParams` (`replyToMessageId?: number`). In `sendMessage`, only include `reply_parameters` in the fetch body when `replyToMessageId` is provided.
  2. **`activity-store.ts`** — Add `activityTimestamp` attribute to the PutItemCommand item: `{ S: \`${classification.activity}#${params.timestamp}\` }`. This populates the new GSI sort key.
  Read tests first — make them pass.

### Task 9-test: Classifier extension tests

- **Type:** test
- **Files:** `test/shared/classifier.test.ts` (modify)
- **Dependencies:** Task 1-impl
- **Description:** Add tests to existing classifier test file for new context parameters:
  1. `classifyMessage` now accepts optional third parameter `context?: { aliases?: Array<{ alias: string, canonicalActivity: string }>, effortEma?: { activity: string, ema: number } }`.
  2. When `aliases` provided, the system prompt includes a "Vocabulary context" section listing each alias mapping.
  3. When `effortEma` provided, the system prompt includes a "Historical effort context" section with the user's typical effort.
  4. When neither provided, system prompt is unchanged from Phase 2.
  5. Existing tests continue to pass (context parameter is optional).
  Read existing tests to follow patterns. Mock already set up for OpenAI.

### Task 9-impl: Classifier extension

- **Type:** impl
- **Files:** `src/shared/services/classifier.ts` (modify)
- **Dependencies:** Task 9-test
- **Description:** Extend `classifyMessage` signature to accept optional `context` parameter. Build system prompt dynamically: start with existing `SYSTEM_PROMPT`, append "Vocabulary context" section if aliases exist (one line per alias: `- "<alias>" means "<canonicalActivity>"`), append "Historical effort context" if effortEma exists. Pass the combined prompt to OpenAI. No changes to model, temperature, or response schema.
  Read tests first — make them pass.

### Task 10-test: Response policy extension tests

- **Type:** test
- **Files:** `test/shared/response-policy.test.ts` (modify)
- **Dependencies:** Task 4-impl
- **Description:** Add tests to existing response policy test file for preference-aware suppression:
  1. `evaluateResponsePolicy` now accepts optional `homeopsTableName` and `userId` (number) in params.
  2. When ignore rate > 0.7 AND sampleCount >= 10: suppress acknowledgments (`"Noterat ✓"`) — return `{ respond: false, reason: "preference_suppressed" }`. Clarifications still sent.
  3. When interaction frequency < 1.0 msg/day AND sampleCount >= 10: suppress clarifications — return `{ respond: false, reason: "low_frequency_suppressed" }`. Acknowledgments still sent.
  4. When sampleCount < 10: no suppression (original behavior).
  5. When `homeopsTableName` not provided: no preference checks (backward compatible).
  6. Existing tests continue to pass unchanged.
  Mock `@shared/services/preference-tracker.js` using `vi.mock()`.

### Task 10-impl: Response policy extension

- **Type:** impl
- **Files:** `src/shared/services/response-policy.ts` (modify)
- **Dependencies:** Task 10-test, Task 4-impl
- **Description:** Extend `PolicyParams` with optional `homeopsTableName?: string` and `userId?: number`. After existing silence checks pass and response text is determined (but before tone validation), add preference checks:
  1. If `homeopsTableName` and `userId` provided, fetch `getIgnoreRate` and `getInteractionFrequency`.
  2. If ignore rate > 0.7 with >= 10 samples AND response is acknowledgment: suppress.
  3. If interaction frequency < 1.0 with >= 10 samples AND response is clarification: suppress.
  Export constants: `IGNORE_RATE_THRESHOLD = 0.7`, `LOW_FREQUENCY_THRESHOLD = 1.0`, `MIN_DATA_POINTS = 10`.
  Read tests first — make them pass.

### Task 11-test: CDK infrastructure extension tests

- **Type:** test
- **Files:** `test/infra/message-store.test.ts` (modify), `test/infra/message-processing.test.ts` (modify)
- **Dependencies:** none
- **Description:** Add CDK assertion tests:
  **MessageStore:**
  1. Activities table has a new GSI `chatId-activity-index` with PK `chatId` (S) and SK `activityTimestamp` (S).
  **MessageProcessing:**
  2. Worker Lambda has new environment variables: `HOMEOPS_TABLE_NAME`, `EMA_ALPHA`, `EMA_ALPHA_IGNORE`.
  3. Worker Lambda IAM role has `dynamodb:PutItem`, `dynamodb:GetItem`, `dynamodb:UpdateItem`, `dynamodb:Query`, `dynamodb:DeleteItem` on homeops table.
  4. Worker Lambda IAM role has `dynamodb:Query` on activities table (for the new GSI).
  5. `MessageProcessingProps` now includes `homeopsTable`.
  Read existing tests to follow established assertion patterns.

### Task 11-impl: CDK infrastructure extension

- **Type:** impl
- **Files:** `infra/constructs/message-store.ts` (modify), `infra/constructs/message-processing.ts` (modify), `infra/stack.ts` (modify)
- **Dependencies:** Task 11-test
- **Description:** Extend CDK infrastructure:
  **`message-store.ts`:**
  1. Add GSI `chatId-activity-index` to activities table with PK `chatId` (STRING) and SK `activityTimestamp` (STRING).
  **`message-processing.ts`:**
  2. Add `homeopsTable: dynamodb.ITable` to `MessageProcessingProps`.
  3. Add environment variables: `HOMEOPS_TABLE_NAME` (from homeopsTable), `EMA_ALPHA` (default "0.3"), `EMA_ALPHA_IGNORE` (default "0.2").
  4. Grant Worker: `dynamodb:PutItem`, `dynamodb:GetItem`, `dynamodb:UpdateItem`, `dynamodb:Query`, `dynamodb:DeleteItem` on homeops table.
  5. Grant Worker: `dynamodb:Query` on activities table (existing grant covers PutItem; add Query).
  **`stack.ts`:**
  6. Pass `homeopsTable: store.homeopsTable` to MessageProcessing props.
  Read tests first — make them pass.

### Task 12-test: Ingest Lambda extension tests

- **Type:** test
- **Files:** `test/handlers/ingest.test.ts` (modify)
- **Dependencies:** none
- **Description:** Add tests to existing ingest handler test file:
  1. SQS message body includes `chatType` from `message.chat.type` (e.g., "group", "private", "supergroup").
  2. SQS message body includes `replyToText` from `message.reply_to_message.text` when present.
  3. When `reply_to_message` has no `text` field, `replyToText` is not included.
  4. When `chat.type` is "private", `chatType` is "private".
  5. Existing tests continue to pass.
  Read existing tests to follow established mock patterns.

### Task 12-impl: Ingest Lambda extension

- **Type:** impl
- **Files:** `src/handlers/ingest/index.ts` (modify)
- **Dependencies:** Task 12-test
- **Description:** Extend the ingest Lambda to pass two new fields through SQS:
  1. Add `chatType: message.chat.type` to the messageBody object.
  2. Add `replyToText: message.reply_to_message.text` conditionally (only when reply_to_message exists AND has text).
  Keep changes minimal — only add the two new fields to the existing messageBody construction.
  Read tests first — make them pass.

### Task 13-test: Worker Lambda integration tests

- **Type:** test
- **Files:** `test/handlers/worker.test.ts` (modify)
- **Dependencies:** Task 2-impl, Task 3-impl, Task 4-impl, Task 5-impl, Task 7-impl, Task 8-impl, Task 9-impl
- **Description:** Add tests to existing worker handler test file. Mock all new service modules using `vi.mock()`:
  - `@shared/services/alias-resolver.js` → `resolveAliases`
  - `@shared/services/effort-tracker.js` → `getEffortEma`, `updateEffortEma`
  - `@shared/services/pattern-tracker.js` → `updatePatternHabit`
  - `@shared/services/preference-tracker.js` → `updateInteractionFrequency`, `updateIgnoreRate`, `getIgnoreRate`
  - `@shared/services/dm-status.js` → `getDmStatus`, `setDmOptedIn`, `markPrompted`
  - `@shared/services/channel-router.js` → `routeResponse`
  - `@shared/services/clarification-handler.js` → `handleClarificationReply`
  - `@shared/services/memory-query.js` → `queryLastActivity`

  **Test cases:**
  1. Private chat with `/start` text: calls `setDmOptedIn`, sends welcome message, does NOT classify.
  2. Private chat with non-`/start` text: logs and skips, does NOT classify.
  3. Reply to bot clarification (replyToIsBot=true, replyToText matches "Menade du..."): calls `handleClarificationReply`, does NOT fall through to classification.
  4. Normal message: calls `resolveAliases` before classification.
  5. Classification receives alias context and effort EMA context from resolveAliases and getEffortEma.
  6. After saving activity: calls `updateEffortEma`, `updatePatternHabit`, `updateInteractionFrequency`.
  7. Response policy receives `homeopsTableName` and `userId` for preference-aware checks.
  8. Ignore rate checked/updated: after bot responds, checks if user ignored previous response.
  9. Existing Phase 2 tests continue to pass (DynamoDB write, classification, response).

### Task 13-impl: Worker Lambda integration

- **Type:** impl
- **Files:** `src/handlers/worker/index.ts` (modify)
- **Dependencies:** Task 13-test, Task 2-impl, Task 3-impl, Task 4-impl, Task 5-impl, Task 7-impl, Task 8-impl, Task 9-impl, Task 10-impl, Task 11-impl, Task 12-impl
- **Description:** Extend the Worker Lambda to integrate all Phase 3 services. The pipeline after Phase 3:
  1. **Existing:** Parse SQS body, write raw message (unchanged).
  2. **NEW — Private chat routing:** If `chatType === "private"`: if text is `/start`, call `setDmOptedIn(homeopsTableName, userId, chatId)`, send welcome DM ("Tack! Du kan nu ta emot personliga uppdateringar från mig."), STOP. Otherwise log and STOP.
  3. **NEW — Clarification response:** If `replyToIsBot && replyToText`, call `handleClarificationReply(...)`. If handled, STOP.
  4. **NEW — Resolve aliases:** Call `resolveAliases(homeopsTableName, chatId, text)`.
  5. **NEW — Get effort context:** Call `getEffortEma(homeopsTableName, userId, ...)` if available.
  6. **MODIFIED — Classify:** Call `classifyMessage(text, apiKey, { aliases, effortEma })`.
  7. If type === "none": STOP.
  8. Save activity (unchanged).
  9. **NEW — Update trackers:** Call `updateEffortEma(...)`, `updatePatternHabit(...)`, `updateInteractionFrequency(...)`. Each wrapped in try-catch.
  10. **MODIFIED — Evaluate policy:** Pass `homeopsTableName` and `userId` for preference checks.
  11. **NEW — Check ignore rate:** On user's message, check if previous bot response was ignored by calling `updateIgnoreRate`.
  12. Route response and send via Telegram (unchanged, but `replyToMessageId` now optional for DM).
  All new calls wrapped in try-catch. Only the raw DynamoDB write may throw to trigger SQS retry.
  Read tests first — make them pass.

---

## Execution Waves

```
Wave 1: Task 1-test, Task 2-test, Task 3-test, Task 4-test, Task 5-test,
         Task 6-test, Task 8-test, Task 11-test, Task 12-test
         (All independent test tasks — no external dependencies)

Wave 2: Task 1-impl, Task 2-impl, Task 3-impl, Task 4-impl, Task 5-impl,
         Task 6-impl, Task 8-impl, Task 11-impl, Task 12-impl,
         Task 7-test, Task 9-test, Task 10-test
         (Impls depend on their test tasks from Wave 1.
          Task 7-test needs Task 1-impl + Task 2-impl for imports.
          Task 9-test needs Task 1-impl for extended types.
          Task 10-test needs Task 4-impl for preference tracker module.)

Wave 3: Task 7-impl, Task 9-impl, Task 10-impl
         (Each depends on its test task from Wave 2.)

Wave 4: Task 13-test
         (Needs all service impl files to exist for vi.mock() imports.
          Depends on Wave 2 + Wave 3 impls.)

Wave 5: Task 13-impl
         (Depends on Task 13-test + all service impls.)
```

**Critical path:** 1-test → 1-impl → 7-test → 7-impl → 13-test → 13-impl (5 waves)

**Maximum parallelism:** 9 tasks (Wave 1), 12 tasks (Wave 2)

---

## Context Budget Check

- [x] No task touches more than 5 files (max: Task 11-impl with 3 files)
- [x] Each task description is under 20 lines
- [x] Each task can be understood without reading the full plan
- [x] Dependencies are explicit — no implicit ordering
- [x] Every impl task depends on its corresponding test task
- [x] No test task depends on its own impl task
