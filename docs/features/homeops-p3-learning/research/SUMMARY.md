# Phase 3 Research Synthesis

**Feature:** homeops-p3-learning
**Date:** 2026-02-17
**Sources:** [ema-implementation.md](ema-implementation.md), [dynamodb-patterns.md](dynamodb-patterns.md), [clarification-detection.md](clarification-detection.md), [telegram-dm-lifecycle.md](telegram-dm-lifecycle.md)

---

## Recommended Approach

Phase 3 adds six capabilities to the existing worker pipeline: alias learning, effort EMA tracking, preference learning, pattern habit tracking, channel routing (group vs DM), and memory queries. All researchers converge on a single critical architectural insight: **the existing `homeops` single table with its PK/SK schema and one GSI is sufficient for all Phase 3 record types, and no new DynamoDB tables are needed.** The only new infrastructure is one GSI on the `activities` table for memory queries, and wiring the `homeops` table to the Worker Lambda.

The implementation should be structured in this order:

1. **Infrastructure wiring (CDK).** Grant the Worker Lambda access to the `homeops` table and add the `chatId-activity-index` GSI to the activities table. This unblocks all subsequent work.

2. **Ingest Lambda extensions.** Add `chatType` and `replyToText` to the SQS message body. These are two small additions that enable the clarification detection and DM routing flows downstream.

3. **Alias system (seed + learning).** Build the alias store, seed vocabulary loader, alias resolver (pre-classification lookup with Lambda in-memory caching), and clarification response handler (hybrid rule-based + OpenAI). This is the highest-value feature because it directly improves classification accuracy.

4. **Effort EMA tracker.** Implement the read-then-conditional-write EMA service, integrated into the worker pipeline after activity storage. Uses optimistic locking on `sampleCount`.

5. **Pattern habit tracker.** Implement the read-modify-write pattern habit service for day-of-week and hour-of-day counters, integrated alongside the effort tracker.

6. **Preference tracker + response policy adaptation.** Track ignore rate (EMA on binary 0/1), interaction frequency (EMA on daily message counts), and active hours (derived from existing PATTERN records). Extend the response policy to suppress optional responses for high-ignore-rate users and reduce clarifications for low-frequency users, gated by a 10-data-point minimum.

7. **DM lifecycle.** Detect `/start` in private chats, store DM opt-in status, implement the channel router, and make `replyToMessageId` optional in the Telegram sender for proactive DM sends.

8. **Memory queries.** Implement the query handler for "who did X last?", "when did user last do X?", and "how many times this week?" using the new GSI and existing `userId-timestamp-index`.

The worker pipeline after Phase 3 will have this shape:

```
SQS message arrives
  -> Parse body
  -> Store raw message
  -> Is private chat?
     -> /start? Store DM opt-in, send welcome, STOP
     -> Other? Log and skip, STOP
  -> Is reply to bot clarification?
     -> Affirmative? Create/confirm alias, STOP
     -> Corrective? Extract activity via classifier, create alias, STOP
     -> Ambiguous? Skip alias creation, fall through to normal pipeline
  -> Resolve aliases for chat (cached, 5-min TTL)
  -> Classify via OpenAI (with alias + effort EMA context)
  -> If "none": STOP
  -> Save activity event
  -> Update effort EMA
  -> Update pattern habit
  -> Update interaction frequency
  -> Evaluate response policy (now preference-aware)
  -> Route response (group vs DM vs none)
  -> Send via Telegram
```

---

## Key Findings

### EMA Implementation ([ema-implementation.md](ema-implementation.md))

- **PRD alpha values are well-chosen.** Alpha 0.3 for effort adapts in ~9 observations (1-4 weeks at household scale); alpha 0.2 for ignore rate is intentionally conservative (requires 7 consecutive ignores from zero to cross the 0.7 threshold).
- **DynamoDB does not support multiplication in UpdateExpression.** EMA cannot be computed atomically. A read-then-conditional-write pattern with `sampleCount` as the optimistic lock is required -- but the concurrency risk is near-zero at household scale.
- **Round EMA to 4 decimal places before storage.** Prevents floating-point noise and ensures deterministic optimistic locking comparisons.
- **Interaction frequency should use EMA on daily message counts (alpha 0.2), not a rolling 7-day window.** Simpler storage (one number vs seven per-day counters). Days with zero messages are skipped, biasing upward -- acceptable for the "< 1 msg/day" threshold.
- **Active hours should be derived from PATTERN records' `hourOfDayCounts`, not stored separately.** Avoids duplicating hour-of-day tracking. However, this lacks recency weighting -- see Open Decisions.

### DynamoDB Patterns ([dynamodb-patterns.md](dynamodb-patterns.md))

- **Alias lookup: single `Query` per chatId, cached in Lambda module scope with 5-minute TTL.** A household accumulates 20-100 aliases (~30 KB). One query returns all; caching eliminates the read on warm invocations.
- **Pattern habit updates: use read-modify-write (GetItem + PutItem), not nested UpdateExpression.** DynamoDB nested map updates have a first-write ordering caveat that makes single-call atomic updates unreliable for new items. The simpler read-modify-write is safe at household concurrency.
- **Memory queries require a new GSI on the activities table.** "Who did X last?" cannot be served by the existing `userId-timestamp-index` because the user is unknown. A `chatId-activity-index` GSI with composite sort key (`<activity>#<timestamp>`) enables efficient `begins_with` queries.
- **Total DynamoDB cost for Phase 3: ~$0/month.** ~860 RCU + ~620 WCU per day at 200 messages, well within on-demand free tier.

### Clarification Detection ([clarification-detection.md](clarification-detection.md))

- **Hybrid approach: rule-based for affirmatives and simple negations, OpenAI for corrections.** Rule-based handles ~80% of clarification responses at zero cost and <1ms. The existing classifier handles correction extraction (Swedish morphology, compound words, verb normalization) with no new prompt needed.
- **Swedish affirmatives are a finite, well-enumerated set** across three tiers: standard (ja, japp, jepp, jo, precis, absolut), informal (aa, mm, okej, jadaa), and emoji (thumbs up, checkmark). Full regex provided.
- **Corrective replies: strip negation prefix, run remainder through existing `classifyMessage`.** Only create alias if classifier returns confidence >= 0.70.
- **Extract the suggested activity from the bot's clarification text** using regex (`/^Menade du (.+)\?$/`), avoiding any DynamoDB lookup for the original context.
- **Important linguistic edge cases:** `nahaa` is surprise (not negation), `naamen` is an interjection (not negation), only `naa`, `naaa`, `nej`, `nix`, `nope` should be treated as negations.

### Telegram DM Lifecycle ([telegram-dm-lifecycle.md](telegram-dm-lifecycle.md))

- **Users must send `/start` before the bot can DM them.** This is a hard Telegram constraint. Attempting to DM a user who has not started a private chat yields `400 Bad Request: chat not found`.
- **In private chats, `chat.id === from.id`.** No separate private chat ID needs to be stored, though the PRD schema stores it explicitly (defensive, self-documenting).
- **Current `allowed_updates: ["message"]` already delivers `/start` from private chats.** No webhook changes needed for Phase 3. Block detection (`my_chat_member`) is deferred -- reactive 403 detection on DM send is sufficient.
- **The Telegram sender needs `replyToMessageId` made optional** for proactive DM sends without a reply context.
- **DM responses naturally avoid counting against the group cap** because the response counter keys on chatId, and private chat IDs (positive) differ from group chat IDs (negative).

---

## Risks & Mitigations

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **EMA optimistic locking conflict** (two Lambda invocations update same user+activity simultaneously) | Near-zero (SQS batch size 1, 50-200 msgs/day) | Lost EMA data point (self-corrects next observation) | Log warning and skip. No retry needed. |
| **Stale alias cache causes misclassification** | Low (aliases change rarely) | One message classified without new alias context | 5-minute TTL limits staleness window. Acceptable trade-off vs. querying on every message. |
| **OpenAI cost increase from correction extraction** | Low (~2 extra calls/day for corrections) | ~$0.009/month | Negligible. Hybrid approach already minimizes calls. |
| **DynamoDB nested map update fails on first write** for pattern habits | Medium (first activity for any user+activity combo) | Pattern not recorded for that event | Read-modify-write approach avoids this entirely. |
| **Worker Lambda timeout** (Phase 3 adds 2-3 DynamoDB reads/writes per message) | Low (each operation is ~5ms) | Message reprocessed via SQS retry | Current 60s timeout is ample. Monitor P99 duration post-deploy. |
| **New GSI on activities table** causes deployment issues with existing data | Low (DynamoDB allows online GSI addition) | Deployment blocked | GSI backfill is automatic and handles existing items. New attribute (`activityTimestamp`) only populated on new writes; old items lack it but are not queried for recent activity. |

### Product Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Learning bad aliases** from misunderstood clarification responses | Incorrect future classifications | Confidence threshold (>= 0.70) on corrections; `confirmations` counter tracks reliability; explicit corrections always override. |
| **Premature preference adaptation** suppresses responses before enough data | User misses important acknowledgments | Hard 10-data-point minimum before any behavioral change. |
| **Onboarding prompt feels spammy** | User annoyance | One-time per user, delivered as a reply to the user's own message, not unprompted. Deep link makes opt-in frictionless. |
| **DM "surveillance" perception** | User distrust | Frame adaptation as "learning preferences", never announce changes in group chat, subtle DM hints only. |
| **Ignore rate biased by "check on next message" approach** | Inaccurate ignore rate for infrequent users | Acceptable at household scale; 10-data-point threshold guards against acting on unreliable data. |

---

## Open Decisions

These require product/developer input before the technical plan can be finalized:

1. **Active hours: separate PREF record or derived from PATTERN data?**
   The PRD specifies a `PREF#<userId>` / `activeTimes` record. The EMA researcher recommends deriving active hours from the PATTERN records' `hourOfDayCounts` to avoid duplication. Deriving is simpler but lacks recency weighting (all historical hours count equally). The trade-off: follow the PRD exactly (separate record with decaying counters) or simplify (derive from PATTERN). The answer depends on whether recency matters for active-hour tracking.

2. **Ignore rate measurement: "check on next message" vs EventBridge scheduled check?**
   The PRD defines "ignored" as no reply within 30 minutes. The simple approach (check when the user's next message arrives) is imprecise -- if a user responds to the bot but sends no further messages for hours, the check is delayed. An EventBridge rule per bot response would be precise but adds significant infrastructure (one scheduled event per bot response). Recommendation leans toward "check on next message," but this is a cost-vs-precision trade-off.

3. **Alias key: classifier's activity name or the user's original phrasing?**
   The clarification researcher flagged this tension. Using the classifier's output (e.g., "pant") as the alias key is simpler and consistent. Using the user's exact phrasing (e.g., "pantade") captures the actual vocabulary but requires extracting the specific ambiguous word from the original message. The PRD implies the latter. Recommendation: start with the classifier's activity name for simplicity, revisit if alias matching proves too narrow.

4. **Interaction frequency: should zero-activity days count?**
   The "update on first message of new day" approach skips days with zero messages, biasing the EMA upward. This means a user who messages 3 days out of 7 looks more active than they are. The PRD's "< 1 msg/day" threshold may need adjustment if zero-days are excluded. Decide whether to accept this bias or add a mechanism to record zero-days (e.g., a daily scheduled Lambda that closes all users' day counts).

5. **Welcome message text for DM `/start`.**
   The PRD does not specify what the bot says when a user starts a private chat. Suggested: "Tack! Du kan nu ta emot personliga uppdateringar fran mig." This is a UX decision.

6. **Should the `CONFIDENCE_CLARIFY` threshold (0.50) be adjusted now that alias learning provides feedback?**
   With aliases improving future classifications, the system could afford to clarify more aggressively (e.g., 0.40-0.84). Each clarification becomes a learning opportunity. But this risks annoying users. Defer or decide.

---

## Conflicts

### 1. Pattern Habit Update Strategy

The DynamoDB researcher presents two approaches for pattern habit updates:

- **Conditional two-call approach:** Try an UpdateItem with `ConditionExpression: attribute_exists(pk)` for the nested map increment. If it fails (new item), fall back to PutItem with initialized maps.
- **Read-modify-write approach:** Always GetItem first, then PutItem with the full item. Simpler code, not atomic.

Both are valid at household scale. The researcher recommends read-modify-write for simplicity. The EMA researcher uses a similar read-then-conditional-write pattern but with optimistic locking. **Resolution:** Use read-modify-write for pattern habits (no optimistic locking needed -- pattern counters are tolerant of rare lost increments) and read-then-conditional-write with optimistic locking for EMA (correctness matters more for averages than counters).

### 2. Active Hours: PREF Record vs PATTERN Derivation

The EMA researcher recommends deriving active hours from existing PATTERN records to avoid duplication. The PRD specifies a separate `PREF#<userId>` / `activeTimes` record. The DynamoDB researcher's schema analysis includes PREF records in the table design.

**Tension:** Following the PRD means maintaining two parallel hour-of-day tracking mechanisms (PATTERN `hourOfDayCounts` and PREF `activeTimes`). Deriving from PATTERN is simpler but deviates from the PRD and lacks recency weighting.

**Resolution recommendation:** Derive from PATTERN data for Phase 3 initial implementation. If recency-weighted active hours prove necessary for preference adaptation, add a decaying counter map in a future iteration. This is flagged as an Open Decision above.

### 3. Alias Key Identity

The clarification researcher identifies a tension between two approaches:

- **Classifier's activity name** as the alias key (e.g., "pant" -> "pantning"): simpler, consistent, but only helps when the classifier already partially recognizes the term.
- **User's original phrasing** as the alias key (e.g., "pantade" -> "pantning"): captures actual vocabulary, matches PRD intent, but requires extracting the ambiguous word from the original message text.

**Resolution recommendation:** Start with the classifier's activity name. If alias matching proves too narrow in practice (users repeat the exact phrasing that the classifier already handles), add original-phrasing extraction as an enhancement. Flagged as Open Decision.

### 4. EMA Update Approach: Effort vs Preference

The EMA researcher uses optimistic locking (`ConditionExpression: sampleCount = :expected`) for effort EMA updates. The DynamoDB researcher recommends simple read-modify-write (no locking) for pattern habits.

**No real conflict:** These are different record types with different correctness requirements. EMA averages benefit from optimistic locking because a lost update biases the average. Pattern counters (incrementing counts) are less sensitive -- a lost +1 on a day-of-week counter is insignificant. Use optimistic locking for EMA records and simple read-modify-write for pattern records.

---

## CDK & Infrastructure Changes

All changes consolidated from all research files:

### Existing Resources Modified

1. **`/infra/constructs/message-processing.ts`** -- Wire `homeops` table to Worker Lambda:
   - Add `homeopsTable: dynamodb.ITable` prop
   - Grant Worker Lambda `dynamodb:PutItem`, `GetItem`, `UpdateItem`, `Query`, `DeleteItem` on `homeops` table
   - Add `HOMEOPS_TABLE_NAME` environment variable to Worker Lambda
   - Add `EMA_ALPHA` environment variable (default: `"0.3"`)
   - Add `EMA_ALPHA_IGNORE` environment variable (default: `"0.2"`)

2. **`/infra/constructs/message-store.ts`** -- Add GSI to activities table:
   ```typescript
   this.activitiesTable.addGlobalSecondaryIndex({
     indexName: "chatId-activity-index",
     partitionKey: { name: "chatId", type: dynamodb.AttributeType.STRING },
     sortKey: { name: "activityTimestamp", type: dynamodb.AttributeType.STRING },
     projectionType: dynamodb.ProjectionType.ALL,
   });
   ```

3. **`/infra/stacks/homeops-stack.ts`** (or equivalent) -- Pass `homeopsTable` from `MessageStore` to `MessageProcessing` construct.

### No New Tables or GSIs on `homeops` Table

The existing `homeops` table schema (PK: `pk`, SK: `sk`, GSI1: `gsi1pk`/`gsi1sk`) is sufficient for all Phase 3 record types. The GSI1 is used by alias records for reverse lookups (`ALIASES_BY_ACTIVITY#<chatId>` prefix). No second GSI is needed.

### Webhook Registration

No changes needed. `allowed_updates: ["message"]` already delivers `/start` from private chats. `my_chat_member` deferred to Phase 5-6.

---

## New Services & Files

All new files follow existing codebase patterns (low-level `@aws-sdk/client-dynamodb`, ESM with `.js` extensions for NodeNext):

### Services (`/src/shared/services/`)

| File | Purpose | Key Exports |
|------|---------|-------------|
| `alias-store.ts` | CRUD for alias records in `homeops` table | `getAliasesForChat`, `putAlias`, `incrementConfirmation`, `deleteAlias` |
| `alias-resolver.ts` | Pre-classification alias lookup with Lambda in-memory cache (5-min TTL) | `resolveAliases(chatId, text)` |
| `effort-tracker.ts` | EMA computation + DynamoDB read-then-conditional-write | `getEffortEma`, `updateEffortEma` |
| `preference-tracker.ts` | Ignore rate EMA, interaction frequency EMA, derived active hours | `getIgnoreRate`, `updateIgnoreRate`, `getInteractionFrequency`, `updateInteractionFrequency` |
| `pattern-tracker.ts` | Day-of-week and hour-of-day counters via read-modify-write | `updatePatternHabit`, `getPatternHabit` |
| `dm-status.ts` | DM opt-in status management | `getDmStatus`, `setDmOptedIn`, `setDmOptedOut`, `markPrompted` |
| `channel-router.ts` | Pure function: (contentType, isDmOptedIn) -> "group" / "dm" / "none" | `routeResponse` |
| `clarification-handler.ts` | Hybrid affirmative/corrective detection + alias creation | `handleClarificationReply` |
| `memory-query.ts` | "Who did X last?", "When did user do X?", "How many times?" | `queryLastActivity`, `queryUserActivity`, `queryActivityCount` |

### Types (`/src/shared/types/`)

| Change | Detail |
|--------|--------|
| Extend `MessageBody` in `classification.ts` | Add `chatType?: "private" \| "group" \| "supergroup"`, `replyToText?: string` |

### Handlers (`/src/handlers/`)

| Change | Detail |
|--------|--------|
| Extend `ingest/index.ts` | Add `chatType: message.chat.type` and `replyToText: message.reply_to_message?.text` to SQS message body |
| Extend `worker/index.ts` | Add early routing for private chat messages and clarification responses; integrate effort, pattern, preference trackers; add channel routing before send |

### Data (`/src/shared/data/` or similar)

| File | Purpose |
|------|---------|
| `seed-aliases.ts` | Predefined Swedish household alias mappings (e.g., "pant" -> "pantning", "dammsuga" -> "dammsugning") |
| `swedish-patterns.ts` | Affirmative word list, negation word list, ambiguous word list, regex patterns for clarification detection |

### Constants/Config

| Addition | Location |
|----------|----------|
| `EFFORT_VALUES` map (`low: 1, medium: 2, high: 3`) | `effort-tracker.ts` or shared constants |
| `ALIAS_CACHE_TTL_MS` (5 min) | `alias-resolver.ts` |
| `MIN_DATA_POINTS_FOR_ADAPTATION` (10) | `response-policy.ts` or preference-tracker |
| `IGNORE_RATE_THRESHOLD` (0.7) | `response-policy.ts` |
| `LOW_FREQUENCY_THRESHOLD` (1.0 msg/day) | `response-policy.ts` |

### Modifications to Existing Services

| File | Change |
|------|--------|
| `telegram-sender.ts` | Make `replyToMessageId` optional in `SendMessageParams`; omit `reply_parameters` when not provided |
| `response-policy.ts` | Add preference-aware suppression logic (high ignore rate, low frequency), gated by 10-data-point minimum |
| `activity-store.ts` | Populate `activityTimestamp` attribute (`<activity>#<timestamp>`) for the new GSI |
| `classifier.ts` | Accept alias context and effort EMA context in classification prompt |

---

## Missing Research: Codebase Analysis

The planned `codebase-analysis.md` research file was not produced. However, all four researchers incorporated codebase references throughout their documents, citing specific files and line numbers in the existing worker pipeline, classification system, DynamoDB tables, and Telegram integration. No critical gaps were identified from the absence of a dedicated codebase analysis -- the integration points are well-documented across the existing research.

Key codebase references surfaced by researchers:
- Worker pipeline: `/src/handlers/worker/index.ts` (activity storage at line 77, response policy at line 93, bot message ID at lines 132-149)
- Message processing construct: `/infra/constructs/message-processing.ts` (SQS batch size 1 at line 63)
- Message store construct: `/infra/constructs/message-store.ts` (homeops table at lines 24-37, GSI1 at lines 33-37)
- Telegram sender: `/src/shared/services/telegram-sender.ts` (bot info cache at line 48)
- Response counter: `/src/shared/services/response-counter.ts` (atomic counter pattern)
- Classifier: `/src/shared/services/classifier.ts` (Swedish verb handling at lines 33-40)
- Ingest handler: `/src/handlers/ingest/index.ts` (message body construction at lines 39-46)
