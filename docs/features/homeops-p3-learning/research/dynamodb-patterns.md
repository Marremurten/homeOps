# DynamoDB Patterns: Memory System & Learning

**Feature:** homeops-p3-learning
**Research Question:** Efficient DynamoDB access patterns for alias lookup, reverse alias GSI, pattern habit aggregation, memory queries, table schema sufficiency, read/write cost analysis, and practical recommendations for the Phase 3 memory system.
**Date:** 2026-02-17

## Summary

Phase 3 adds five new record types (aliases, effort EMA, preferences, pattern habits, DM status) to the existing `homeops` single table (PK: `pk`, SK: `sk`, GSI1: `gsi1pk`/`gsi1sk`). The existing single GSI is sufficient for all Phase 3 query patterns. Alias lookup at classification time adds one DynamoDB Query per message (~20-100 items returned, well within a single 4KB read unit). Pattern habit map counters require a two-step UpdateExpression that initializes the parent map with `if_not_exists` before incrementing nested keys. Memory queries ("who did X last?") need a new GSI on the `activities` table (`chatId-activity-index`) because the existing `userId-timestamp-index` cannot efficiently query by activity name across all users in a chat. Total per-message DynamoDB cost remains well within the free tier at household scale.

## Findings

### 1. Alias Lookup at Classification Time

**Record Design (from PRD):**
- PK: `ALIAS#<chatId>`, SK: `<normalizedAlias>`
- Attributes: `canonicalActivity`, `confirmations`, `source`, `learnedFrom`, `gsi1pk`, `gsi1sk`, timestamps

**Query Pattern:** Before classifying a message, fetch ALL aliases for the chat to resolve known vocabulary.

**Query vs BatchGetItem Analysis:**

| Approach | When to Use | For Alias Lookup |
|----------|-------------|------------------|
| `Query(PK = "ALIAS#<chatId>")` | Fetch all items sharing a partition key | Natural fit -- we want ALL aliases for a chat |
| `BatchGetItem` | Fetch specific items by exact PK+SK | Would require knowing which aliases to look up beforehand -- defeats the purpose |

**Recommendation: Use `Query`.** The access pattern is "get everything under this partition key," which is exactly what `Query` does. `BatchGetItem` requires knowing the exact sort keys in advance, which is not the case here -- we need all aliases to scan the message text for matches.

**Efficiency at Expected Volume:**

A household will accumulate 20-100 aliases over time. Each alias record is roughly 200-300 bytes. At 100 aliases:

- Total data: ~30 KB
- DynamoDB reads: 8 RCU (eventually consistent, 4 KB per RCU, ~30 KB / 4 KB = 8)
- Latency: single-digit milliseconds (single partition, sequential read)
- Cost: 8 RCU * $0.283 per million RRU = negligible

This is a single Query call returning all results in one response (no pagination needed -- DynamoDB paginates at 1 MB, and 30 KB is well below that).

**Lambda In-Memory Caching:**

Aliases change infrequently (only when users confirm/correct clarifications). Caching aliases in module-scope memory across Lambda warm invocations is beneficial:

```typescript
// Module-scope cache, survives across warm invocations
let aliasCache: Map<string, { aliases: AliasRecord[]; fetchedAt: number }> = new Map();
const ALIAS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getAliasesForChat(tableName: string, chatId: string): Promise<AliasRecord[]> {
  const cacheKey = chatId;
  const cached = aliasCache.get(cacheKey);
  const now = Date.now();

  if (cached && (now - cached.fetchedAt) < ALIAS_CACHE_TTL_MS) {
    return cached.aliases;
  }

  const aliases = await queryAliases(tableName, chatId);
  aliasCache.set(cacheKey, { aliases, fetchedAt: now });
  return aliases;
}
```

**Trade-off:** Stale aliases for up to 5 minutes after a user correction. This is acceptable because:
- Alias corrections are rare (a few per week at most)
- A 5-minute stale window means at most 1-2 messages classified with the old alias
- Saves a DynamoDB Query on every single message in warm Lambda invocations

**Query Implementation:**

```typescript
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

async function queryAliases(tableName: string, chatId: string): Promise<AliasRecord[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": { S: `ALIAS#${chatId}` },
      },
    }),
  );

  return (result.Items ?? []).map((item) => ({
    alias: item.sk.S!,
    canonicalActivity: item.canonicalActivity.S!,
    confirmations: Number(item.confirmations?.N ?? "0"),
    source: item.source.S! as "seed" | "learned",
  }));
}
```

This follows the existing codebase pattern in `/Users/martinnordlund/homeOps/src/shared/services/fast-conversation.ts` which also uses `QueryCommand` with the low-level `@aws-sdk/client-dynamodb` client.

---

### 2. GSI for Reverse Alias Lookups

**Proposed GSI1 mapping (from PRD):**
- `gsi1pk = ALIASES_BY_ACTIVITY#<chatId>`, `gsi1sk = <canonicalActivity>`

**Use Case:** "What aliases map to this activity?" -- needed when a user corrects an alias and we need to find/update existing aliases that point to the same canonical activity.

**Is This GSI Necessary?**

The reverse lookup use case occurs in two scenarios:

1. **Alias override logic:** When a user says "nej, jag menade tvattt" (correcting a clarification), the system needs to check if an alias already points to a different activity. This is a point lookup on the base table: `Query(PK = "ALIAS#<chatId>", SK = "<normalizedAlias>")`. No GSI needed.

2. **"What aliases map to diskning?"** This reverse query is needed when displaying alias information or when merging/cleaning aliases. The frequency is very low -- essentially an admin/debug operation.

**Analysis of Alternatives:**

| Approach | Pros | Cons |
|----------|------|------|
| GSI1 (as proposed) | Single Query for reverse lookup | Extra write amplification on every alias write; uses the shared GSI1 slot |
| Filter on base table Query | No GSI needed | Reads all aliases for chat, filters in app -- fine for 20-100 items |
| Separate reverse-lookup items | Full control | Doubles alias storage; requires transactional writes to keep in sync |

**Recommendation: Use the GSI1 as proposed in the PRD, but understand the cost is negligible.**

At household scale (20-100 alias records), filtering in application code after a base table Query would work equally well. However, the GSI1 approach is cleaner and follows the single-table design conventions already established in `/Users/martinnordlund/homeOps/infra/constructs/message-store.ts` (lines 33-37). The write amplification cost is effectively zero:

- Aliases are written/updated at most a few times per week
- Each alias item is ~300 bytes, well under the 1 KB minimum WCU
- GSI write = 1 additional WCU per alias mutation = negligible at this scale

The GSI1 slot is shared across entity types in the `homeops` table, but Phase 3 entities using it (aliases with `ALIASES_BY_ACTIVITY#` prefix) do not conflict with any future Phase 4-6 patterns because the prefixed partition key ensures namespace isolation.

**Important note:** The `homeops` table GSI1 already exists (defined in `message-store.ts` lines 33-37) with `gsi1pk` and `gsi1sk` as STRING attributes. No CDK changes are needed for this -- alias records simply populate these attributes when written.

---

### 3. Pattern Habit Aggregation

**Record Design (from PRD):**
- PK: `PATTERN#<chatId>#<userId>`, SK: `<canonicalActivity>`
- `dayOfWeekCounts`: Map `{ "mon": 5, "tue": 2, ... }`
- `hourOfDayCounts`: Map `{ "0": 1, "8": 4, ... }`
- `totalCount`: Number
- `lastSeen`: ISO 8601

**The Problem:** How to atomically increment a specific key within a DynamoDB Map attribute (e.g., increment `dayOfWeekCounts.mon` by 1) when the key or the parent map might not exist yet.

**DynamoDB Constraints for Nested Map Updates:**

1. **`ADD` only works on top-level Number/Set attributes.** You cannot use `ADD dayOfWeekCounts.mon :one` -- DynamoDB will reject this.
2. **Nested SET paths fail if parent map does not exist.** `SET dayOfWeekCounts.mon = dayOfWeekCounts.mon + :one` throws `ValidationException` if `dayOfWeekCounts` does not exist on the item.
3. **`if_not_exists` works on nested paths** for the value side, but the path itself must be valid.

**Solution: Two-Part UpdateExpression**

Initialize the parent map with `if_not_exists`, then increment the nested key, all in a single `UpdateItem` call:

```typescript
// Example: increment dayOfWeekCounts.mon and hourOfDayCounts.14
const dayKey = "mon"; // derived from Stockholm timezone
const hourKey = "14"; // derived from Stockholm timezone

const updateExpression = [
  // Step 1: Ensure parent maps exist (no-op if they already do)
  "SET dayOfWeekCounts = if_not_exists(dayOfWeekCounts, :emptyMap)",
  "hourOfDayCounts = if_not_exists(hourOfDayCounts, :emptyMap)",
  // Step 2: Increment the specific keys within the maps
  `dayOfWeekCounts.#dayKey = if_not_exists(dayOfWeekCounts.#dayKey, :zero) + :one`,
  `hourOfDayCounts.#hourKey = if_not_exists(hourOfDayCounts.#hourKey, :zero) + :one`,
  // Step 3: Update scalar fields
  "totalCount = if_not_exists(totalCount, :zero) + :one",
  "lastSeen = :now",
  "updatedAt = :now",
].join(", ");

await client.send(
  new UpdateItemCommand({
    TableName: tableName,
    Key: {
      pk: { S: `PATTERN#${chatId}#${userId}` },
      sk: { S: canonicalActivity },
    },
    UpdateExpression: `SET ${updateExpression}`,
    ExpressionAttributeNames: {
      "#dayKey": dayKey,
      "#hourKey": hourKey,
    },
    ExpressionAttributeValues: {
      ":emptyMap": { M: {} },
      ":zero": { N: "0" },
      ":one": { N: "1" },
      ":now": { S: new Date().toISOString() },
    },
  }),
);
```

**Why This Works:**

DynamoDB evaluates all SET clauses in a single `UpdateItem` atomically. The order within a SET clause matters: `if_not_exists(dayOfWeekCounts, :emptyMap)` initializes the parent map if the item is new or the attribute is missing, then `dayOfWeekCounts.#dayKey = if_not_exists(dayOfWeekCounts.#dayKey, :zero) + :one` safely increments the nested counter.

**Critical caveat on expression ordering:** DynamoDB processes SET actions in the order they appear, but all paths are resolved against the item's state *before* the update begins. This means the two-step approach (initialize map, then set nested key) may fail on the very first write to a brand-new item because `dayOfWeekCounts.#dayKey` path resolution happens before `dayOfWeekCounts` is initialized.

**Recommended workaround:** Use a conditional two-call approach:

```typescript
async function updatePatternHabit(
  tableName: string,
  chatId: string,
  userId: number,
  canonicalActivity: string,
  dayKey: string,
  hourKey: string,
): Promise<void> {
  const key = {
    pk: { S: `PATTERN#${chatId}#${userId}` },
    sk: { S: canonicalActivity },
  };

  try {
    // Attempt: Increment nested keys (works if item + maps already exist)
    await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: `SET dayOfWeekCounts.#dayKey = if_not_exists(dayOfWeekCounts.#dayKey, :zero) + :one, hourOfDayCounts.#hourKey = if_not_exists(hourOfDayCounts.#hourKey, :zero) + :one, totalCount = if_not_exists(totalCount, :zero) + :one, lastSeen = :now, updatedAt = :now`,
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: {
          "#dayKey": dayKey,
          "#hourKey": hourKey,
        },
        ExpressionAttributeValues: {
          ":zero": { N: "0" },
          ":one": { N: "1" },
          ":now": { S: new Date().toISOString() },
        },
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      // First time: Create item with initialized maps
      const now = new Date().toISOString();
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Key: key,
          Item: {
            ...key,
            dayOfWeekCounts: { M: { [dayKey]: { N: "1" } } },
            hourOfDayCounts: { M: { [hourKey]: { N: "1" } } },
            totalCount: { N: "1" },
            lastSeen: { S: now },
            updatedAt: { S: now },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } else {
      throw err;
    }
  }
}
```

**Alternative (simpler, recommended): Always use PutItem with a full read-modify-write.**

Since pattern habits are updated once per classified message and concurrency on the same user+activity is essentially impossible at household scale (50-200 messages/day across all users), a simpler approach is:

```typescript
async function updatePatternHabit(
  tableName: string,
  chatId: string,
  userId: number,
  canonicalActivity: string,
  dayKey: string,
  hourKey: string,
): Promise<void> {
  const pk = `PATTERN#${chatId}#${userId}`;
  const sk = canonicalActivity;

  // Read current record (may not exist)
  const existing = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk }, sk: { S: sk } },
    }),
  );

  const dayOfWeekCounts: Record<string, number> = {};
  const hourOfDayCounts: Record<string, number> = {};
  let totalCount = 0;

  if (existing.Item) {
    // Parse existing maps
    for (const [k, v] of Object.entries(existing.Item.dayOfWeekCounts?.M ?? {})) {
      dayOfWeekCounts[k] = Number(v.N);
    }
    for (const [k, v] of Object.entries(existing.Item.hourOfDayCounts?.M ?? {})) {
      hourOfDayCounts[k] = Number(v.N);
    }
    totalCount = Number(existing.Item.totalCount?.N ?? "0");
  }

  // Increment
  dayOfWeekCounts[dayKey] = (dayOfWeekCounts[dayKey] ?? 0) + 1;
  hourOfDayCounts[hourKey] = (hourOfDayCounts[hourKey] ?? 0) + 1;
  totalCount += 1;

  // Write back
  const now = new Date().toISOString();
  const dayMap: Record<string, { N: string }> = {};
  for (const [k, v] of Object.entries(dayOfWeekCounts)) {
    dayMap[k] = { N: String(v) };
  }
  const hourMap: Record<string, { N: string }> = {};
  for (const [k, v] of Object.entries(hourOfDayCounts)) {
    hourMap[k] = { N: String(v) };
  }

  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        pk: { S: pk },
        sk: { S: sk },
        dayOfWeekCounts: { M: dayMap },
        hourOfDayCounts: { M: hourMap },
        totalCount: { N: String(totalCount) },
        lastSeen: { S: now },
        updatedAt: { S: now },
      },
    }),
  );
}
```

**Trade-off:** Read-modify-write is not atomic, but at household scale the probability of two Lambda invocations updating the same user+activity pattern simultaneously is essentially zero. The worker processes SQS messages with `batchSize: 1` (see `/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts` line 63), and even with concurrent invocations, the same user+activity combination would need two messages in the same second. The simplicity benefit far outweighs the theoretical concurrency risk.

---

### 4. Memory Query Support

The PRD defines three query types:

1. **"Who did [activity] last?"** -- Query activities table by activity name within a chat, get most recent
2. **"When did [user] last do [activity]?"** -- Query by userId + activity, get most recent
3. **"How many times this week?"** -- Query by userId + activity with timestamp range

**Current Activities Table Schema (from `/Users/martinnordlund/homeOps/infra/constructs/message-store.ts`):**

```
Base table: homeops-activities
  PK: chatId (String)
  SK: activityId (String, ULID -- time-ordered)
  Attributes: userId (Number), timestamp (Number), activity (String), type, effort, confidence, ...

GSI: userId-timestamp-index
  PK: userId (Number)
  SK: timestamp (Number)
```

**Query Analysis:**

| Query | Approach with Existing Indexes | Efficiency |
|-------|-------------------------------|------------|
| "Who did diskning last?" | Query base table (PK=chatId), filter by activity, ScanForward=false, Limit high | **Poor** -- must scan all activities for the chat, filtering in app code |
| "When did Martin last do diskning?" | Query GSI (PK=userId), filter by activity, ScanForward=false | **Acceptable** -- scans user's activities, filters in app code |
| "How many times this week?" | Query GSI (PK=userId, SK BETWEEN start AND end), filter by activity | **Acceptable** -- time-range limits scan, filter for activity |

**Problem with Query 1:** The base table key is `chatId + activityId`. To find "who did diskning last?", you must scan the chat's entire activity history (potentially hundreds of records over months) and filter for `activity = "diskning"`. With the existing GSI you would need to know the userId first -- but the whole point of the query is to find *which* user.

**Solution: Add a new GSI on the activities table.**

```
GSI: chatId-activity-index
  PK: chatId (String)
  SK: activity#timestamp (String, composite: "<activity>#<timestamp>")
```

However, composite string sort keys require `begins_with` for the activity prefix, which works perfectly:

```typescript
// "Who did diskning last?"
await client.send(
  new QueryCommand({
    TableName: activitiesTableName,
    IndexName: "chatId-activity-index",
    KeyConditionExpression: "chatId = :chatId AND begins_with(activityTimestamp, :activityPrefix)",
    ExpressionAttributeValues: {
      ":chatId": { S: chatId },
      ":activityPrefix": { S: "diskning#" },
    },
    ScanIndexForward: false, // most recent first
    Limit: 1,
  }),
);
```

**Alternative: Use the `homeops` table GSI1 instead of adding a new GSI to activities.**

Since activity records are stored in the dedicated `homeops-activities` table (not the `homeops` single table), the `homeops` table's GSI1 cannot serve these queries. The options are:

| Option | Description | Trade-off |
|--------|-------------|-----------|
| **A. New GSI on activities table** | `chatId-activity-index` with composite SK | Clean; optimized for the exact query pattern; costs 1 extra WCU per activity write |
| **B. Duplicate activity summary in `homeops` table** | Write `LAST_ACTIVITY#<chatId>` records on each activity | Denormalization; requires maintaining two records per activity event |
| **C. Filter on base table Query** | Query all activities for chatId, filter by activity in app code | Works at small scale but degrades as history grows (1000+ activities/year) |

**Recommendation: Option A -- add a `chatId-activity-index` GSI to the activities table.**

```
GSI: chatId-activity-index
  PK: chatId (String)
  SK: activityTimestamp (String, format: "<canonicalActivity>#<timestamp>")
  Projection: ALL (items are ~0.5 KB, same reasoning as userId-timestamp-index)
```

When writing activities, populate the `activityTimestamp` attribute:

```typescript
// In activity-store.ts, add this attribute to the PutItem:
activityTimestamp: { S: `${classification.activity}#${params.timestamp}` },
```

**Query implementations for all three patterns:**

```typescript
// Query 1: "Who did diskning last?"
// GSI: chatId-activity-index, begins_with on activityTimestamp
const result = await client.send(
  new QueryCommand({
    IndexName: "chatId-activity-index",
    KeyConditionExpression: "chatId = :cid AND begins_with(activityTimestamp, :prefix)",
    ExpressionAttributeValues: {
      ":cid": { S: chatId },
      ":prefix": { S: `${activity}#` },
    },
    ScanIndexForward: false,
    Limit: 1,
  }),
);
// Returns: { userName: "Martin", timestamp: 1708123456 }

// Query 2: "When did Martin last do diskning?"
// GSI: userId-timestamp-index (existing), with FilterExpression
const result = await client.send(
  new QueryCommand({
    IndexName: "userId-timestamp-index",
    KeyConditionExpression: "userId = :uid",
    FilterExpression: "activity = :act",
    ExpressionAttributeValues: {
      ":uid": { N: String(userId) },
      ":act": { S: activity },
    },
    ScanIndexForward: false,
    Limit: 10, // over-fetch to compensate for filter
  }),
);

// Query 3: "How many times did Martin do diskning this week?"
// GSI: userId-timestamp-index (existing), with time range + filter
const weekStart = getStockholmWeekStart(); // Monday 00:00 in Unix seconds
const result = await client.send(
  new QueryCommand({
    IndexName: "userId-timestamp-index",
    KeyConditionExpression: "userId = :uid AND #ts BETWEEN :start AND :end",
    FilterExpression: "activity = :act",
    ExpressionAttributeNames: { "#ts": "timestamp" },
    ExpressionAttributeValues: {
      ":uid": { N: String(userId) },
      ":start": { N: String(weekStart) },
      ":end": { N: String(Math.floor(Date.now() / 1000)) },
      ":act": { S: activity },
    },
  }),
);
// Count: result.Items?.length ?? 0
```

**Can the existing `userId-timestamp-index` handle all three?**

No. Query 1 ("Who did X last?") requires querying by chatId + activity without knowing the userId. The existing GSI has userId as the partition key. You would need to iterate over all known userIds in the household, query each one, and merge results -- inefficient and architecturally poor.

---

### 5. Table Schema Sufficiency

**Current `homeops` table schema:**

```
PK: pk (String)
SK: sk (String)
GSI1: gsi1pk (String), gsi1sk (String)
```

**Phase 3 record types and their key patterns:**

| Record Type | PK | SK | gsi1pk | gsi1sk | Needs GSI1? |
|-------------|----|----|--------|--------|-------------|
| Alias | `ALIAS#<chatId>` | `<normalizedAlias>` | `ALIASES_BY_ACTIVITY#<chatId>` | `<canonicalActivity>` | Yes (reverse lookup) |
| Effort EMA | `EFFORT#<userId>` | `<canonicalActivity>` | -- | -- | No |
| Preference | `PREF#<userId>` | `<metricName>` | -- | -- | No |
| Pattern Habit | `PATTERN#<chatId>#<userId>` | `<canonicalActivity>` | -- | -- | No |
| DM Status | `DM#<userId>` | `STATUS` | -- | -- | No |

**GSI1 Usage Analysis:**

Only Alias records use GSI1 for the reverse lookup pattern (`ALIASES_BY_ACTIVITY#<chatId>` -> `<canonicalActivity>`). All other Phase 3 record types are accessed via their base table keys:

- **Effort EMA:** Point read/write by `EFFORT#<userId>` + `<activity>`. No collection queries needed.
- **Preferences:** Query all prefs for a user via `PREF#<userId>`. At most 3-5 items. No GSI needed.
- **Pattern Habits:** Point read/write by `PATTERN#<chatId>#<userId>` + `<activity>`. Query all habits for a user in a chat is served by the base table `Query(PK = "PATTERN#<chatId>#<userId>")`.
- **DM Status:** Point read by `DM#<userId>` + `STATUS`. Single item.

**Is one GSI sufficient for Phase 3?**

Yes. Only the alias reverse lookup requires GSI1, and the prefix-based namespace isolation (`ALIASES_BY_ACTIVITY#<chatId>`) prevents collisions with any other entity type that might use GSI1 in future phases.

**Will future phases (4-6) need a second GSI on the `homeops` table?**

Looking at the roadmap:

- Phase 4 (Balance/Fairness): NetLoad calculations likely query the activities table, not the homeops table
- Phase 5 (Planning): Scheduled events could use GSI1 with a `SCHEDULE#` prefix
- Phase 6 (Insights): Aggregation queries likely happen on activities or pattern data already in the homeops table

**Recommendation: One GSI is sufficient for Phase 3, and likely for all six phases.** The `homeops` table stores configuration/state records that are accessed by known keys. The heavy query patterns (time-range, activity-based) live on the `activities` table which has its own dedicated GSIs. If a second GSI becomes necessary in Phase 5-6, DynamoDB allows adding GSIs without downtime.

---

### 6. Read/Write Cost Analysis

**Per-Message DynamoDB Operations:**

For each incoming message that gets classified as a chore/recovery:

| Step | Operation | Table | RCU/WCU |
|------|-----------|-------|---------|
| 1. Save raw message | PutItem | homeops-messages | 1 WCU |
| 2. Alias lookup | Query | homeops | 1-8 RCU (depending on alias count) |
| 3. Classify (OpenAI) | -- | -- | 0 (API call, not DynamoDB) |
| 4. Save activity | PutItem | homeops-activities | 1 WCU + 1 WCU (userId-timestamp GSI) + 1 WCU (chatId-activity GSI) |
| 5. Update effort EMA | GetItem + PutItem | homeops | 1 RCU + 1 WCU |
| 6. Update pattern habit | GetItem + PutItem | homeops | 1 RCU + 1 WCU |
| 7. Update preferences | UpdateItem | homeops | 1 WCU |
| 8. Response policy check | GetItem (counter) + Query (fast-conv) | homeops-response-counters, homeops-messages | 1 RCU + 1 RCU |
| 9. Increment response counter | UpdateItem (conditional) | homeops-response-counters | 1 WCU |
| **Total per classified message** | | | **~5 RCU + ~8 WCU** |

For messages classified as `type: "none"` (majority -- estimated 60-80% of messages):

| Step | Operation | RCU/WCU |
|------|-----------|---------|
| 1. Save raw message | PutItem | 1 WCU |
| 2. Alias lookup | Query | 1-8 RCU |
| 3. Classify (OpenAI) | -- | 0 |
| **Total per "none" message** | | **~1-8 RCU + 1 WCU** |

**Daily Cost Estimate (200 messages/day):**

- ~60 classified messages: 60 * (5 RCU + 8 WCU) = 300 RCU + 480 WCU
- ~140 "none" messages: 140 * (4 RCU + 1 WCU) = 560 RCU + 140 WCU
- **Daily total: ~860 RCU + ~620 WCU**
- **Monthly total: ~25,800 RCU + ~18,600 WCU**

**DynamoDB Free Tier:** 25 RCU + 25 WCU provisioned, or 2.5 million read requests + 1 million write requests for on-demand.

At ~25,800 reads + ~18,600 writes per month, this is **0.001% of the on-demand free tier allocation.** Cost is effectively $0.00/month.

**Batching Opportunities:**

| Opportunity | Feasible? | Benefit |
|-------------|-----------|---------|
| Batch effort + pattern + preference writes | No -- different items with different update logic | N/A |
| TransactWriteItems for activity + effort + pattern | Possible but overkill | Atomicity not needed; each can fail independently |
| Cache alias lookup across invocations | Yes -- module-scope cache | Reduces ~4 RCU per message to 0 on warm invocations |
| Combine effort read + pattern read | No -- different PKs, BatchGetItem possible | Saves 1 round-trip but adds complexity |

**Recommendation:** The only batching optimization worth implementing is the alias cache (Section 1). All other operations are already efficient enough. `BatchGetItem` for effort + pattern could save one round-trip, but the added code complexity is not justified at this scale.

**On-Demand vs Provisioned Capacity:**

The existing tables use `PAY_PER_REQUEST` (on-demand). At household scale, the total monthly DynamoDB operations are well within the free tier for both models. There is no reason to switch to provisioned capacity. On-demand is the correct choice because:

- Zero capacity planning needed
- No risk of throttling during usage spikes
- Free tier covers the entire workload
- Scales automatically if the household grows

---

### 7. Practical Recommendations

**Recommended DynamoDB Access Patterns by Record Type:**

| Record Type | Create/Update | Read | Notes |
|-------------|--------------|------|-------|
| Alias | `PutItem` with `ConditionExpression` for idempotency | `Query(PK = "ALIAS#<chatId>")` for all; `GetItem` for single | Cache in Lambda memory; invalidate on write |
| Effort EMA | `UpdateItem` with `SET` expression | `GetItem(PK, SK)` for single user+activity | Use `if_not_exists` for cold start initialization |
| Preference | `UpdateItem` with `SET` expression | `Query(PK = "PREF#<userId>")` for all metrics | At most 3 items per user |
| Pattern Habit | Read-modify-write (`GetItem` + `PutItem`) | `GetItem(PK, SK)` for single; `Query(PK)` for all activities | Simplicity over atomicity at household scale |
| DM Status | `PutItem` | `GetItem(PK = "DM#<userId>", SK = "STATUS")` | Written once (on /start), read occasionally |

**Caching Strategy:**

```
Module-scope caches (survive across warm Lambda invocations):
  - Alias cache: Map<chatId, { aliases, fetchedAt }>, TTL 5 minutes
  - Bot info cache: already implemented in telegram-sender.ts (line 48)
  - Secrets cache: already implemented in secrets.ts

NOT cached (change too frequently or vary per message):
  - Effort EMA records
  - Pattern habits
  - Preference metrics
  - Response counters
```

**Error Handling for DynamoDB Operations in the Worker Pipeline:**

Following the established pattern in `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts`:

| Operation | On Failure | Rationale |
|-----------|-----------|-----------|
| Save raw message (PutItem) | Fail the SQS batch item | Message storage is the critical path |
| Alias lookup (Query) | Continue with empty aliases | Classification still works without aliases, just less accurate |
| Save activity (PutItem) | Log error, continue | Already the existing pattern (worker line 88) |
| Update effort EMA | Log error, continue | Learning is non-critical; data loss is one data point |
| Update pattern habit | Log error, continue | Same as effort -- one missed data point is acceptable |
| Update preferences | Log error, continue | Same rationale |
| Response policy + send | Log error, continue | Already the existing pattern (worker line 106-107) |

This follows the Phase 2 principle: classification is the critical path, learning/response operations are best-effort.

**New CDK Changes Required for Phase 3:**

1. **Add GSI to activities table** (in `/Users/martinnordlund/homeOps/infra/constructs/message-store.ts`):

```typescript
this.activitiesTable.addGlobalSecondaryIndex({
  indexName: "chatId-activity-index",
  partitionKey: { name: "chatId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "activityTimestamp", type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});
```

2. **Grant `homeops` table permissions to worker Lambda** (in `/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts`):

```typescript
// Add homeopsTable to MessageProcessingProps
homeopsTable: dynamodb.ITable;

// Grant permissions
props.homeopsTable.grant(worker,
  "dynamodb:PutItem",
  "dynamodb:GetItem",
  "dynamodb:UpdateItem",
  "dynamodb:Query",
  "dynamodb:DeleteItem",
);

// Add environment variable
HOMEOPS_TABLE_NAME: props.homeopsTable.tableName,
```

3. **No new tables needed.** All Phase 3 records use the existing `homeops` single table.

---

## Recommendation

### Summary

| Topic | Recommendation |
|-------|---------------|
| Alias lookup | Single `Query` per chatId; cache in Lambda module scope with 5-min TTL |
| Reverse alias GSI | Use GSI1 as PRD specifies; negligible cost at household scale |
| Pattern habit update | Read-modify-write (`GetItem` + `PutItem`); simpler than nested `UpdateExpression` |
| Memory queries | Add `chatId-activity-index` GSI to activities table for "who did X last?" |
| Table schema | One GSI on `homeops` table is sufficient for all Phase 3 patterns |
| Second GSI | Not needed; defer to Phase 5-6 if needed (can add without downtime) |
| Cost | ~$0/month; well within DynamoDB free tier |
| Caching | Alias cache only; everything else is cheap enough to fetch each time |
| Error handling | Learning operations fail silently (log + continue); message storage is critical path |
| SDK consistency | Continue with `@aws-sdk/client-dynamodb` (low-level) per Phase 1/2 convention |

### Key CDK Changes

1. Add `chatId-activity-index` GSI to the existing `homeops-activities` table
2. Grant `homeops` table permissions to the worker Lambda
3. Pass `HOMEOPS_TABLE_NAME` environment variable to worker

### No New Tables

All Phase 3 record types (aliases, effort EMA, preferences, pattern habits, DM status) fit cleanly in the existing `homeops` single table with its current key schema (`pk`/`sk`) and single GSI (`gsi1pk`/`gsi1sk`).

## Trade-offs

| Decision | What You Gain | What You Give Up |
|----------|--------------|-----------------|
| Alias cache (5-min TTL) | Eliminates ~4 RCU per warm invocation | Stale aliases for up to 5 minutes after correction; adds cache invalidation complexity |
| Read-modify-write for patterns | Simple, readable code; no nested UpdateExpression gymnastics | Not atomic; theoretical (but practically impossible) race condition at household scale |
| New GSI on activities table | Efficient "who did X last?" queries in O(1) | 1 extra WCU per activity write; ~0.5 KB storage duplication per activity |
| Single GSI on homeops table | Simpler schema; fewer indexes to maintain | If Phase 5-6 needs a second access pattern, must add GSI later (zero downtime, but migration work) |
| Best-effort learning writes | Worker never blocks on non-critical DynamoDB failures | Occasional missed data points for effort/pattern/preference tracking |
| No BatchGetItem for effort+pattern | Simpler code; each service module is independent | Two sequential DynamoDB calls instead of one batched call (adds ~5ms latency) |

## Open Questions

1. **Alias cache invalidation strategy.** Should the alias cache be busted immediately after the worker processes a clarification response that creates/updates an alias? This would require the clarification handler to clear the cache entry, which couples the two code paths. Alternative: accept 5-minute staleness and keep the code simple.

2. **Activity text normalization for the new GSI.** The `activity` field from OpenAI classification may vary slightly (e.g., "diska" vs "diskning"). Should the GSI sort key use a normalized form? If so, the normalization must happen at write time and be consistent with how queries construct the `begins_with` prefix. This ties into the alias system -- if aliases normalize "pant" to "pantning", the activity stored should also be "pantning".

3. **Pattern habit cold start at seed time.** When seed aliases are loaded (first deployment), should seed patterns also be initialized, or should the pattern system start from zero and learn from scratch? Starting from zero is simpler and avoids fabricating data.

4. **GSI projection type for `chatId-activity-index`.** This document recommends `ALL` for consistency with the existing `userId-timestamp-index`. However, `INCLUDE` with only `userId`, `userName`, `timestamp`, and `effort` might be sufficient for memory queries. The cost difference at household scale is zero, so `ALL` is the safer default.

5. **Should effort EMA and pattern habit reads be combined?** Both read from the `homeops` table with different PKs. A `BatchGetItem` could fetch both in one call. At ~5ms per DynamoDB call, this saves one round-trip per classified message. Whether this optimization is worth the code coupling is a judgment call -- the recommendation is "no" for now, revisit if Lambda duration becomes a concern.
