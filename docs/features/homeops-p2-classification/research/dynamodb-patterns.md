# DynamoDB Patterns: Activity Logging & Rate Limiting

**Feature:** homeops-p2-classification
**Research Question:** ULID generation, atomic counters, timezone handling, TTL, GSI design, CDK definitions, and fast conversation detection for Phase 2 DynamoDB tables
**Date:** 2026-02-17

## Summary

Phase 2 introduces two new DynamoDB tables (`homeops-activities` and `homeops-response-counters`) alongside the existing `homeops-messages` table. This document covers seven technical areas: ULID generation via `ulidx` for time-ordered sort keys, atomic counter upserts with DynamoDB `ADD` expressions, Stockholm timezone date boundaries using `Intl.DateTimeFormat`, TTL auto-cleanup configuration, GSI design validation for user activity queries, CDK table definitions, and an efficient recent-messages query for fast conversation detection. All patterns use AWS SDK v3 with the low-level `@aws-sdk/client-dynamodb` client to stay consistent with the existing Phase 1 codebase.

## Findings

### 1. ULID Generation

#### Why ULID Over UUID for Sort Keys

ULIDs (Universally Unique Lexicographically Sortable Identifiers) are the correct choice for the `activityId` sort key because:

1. **Lexicographic sort = chronological sort.** A DynamoDB `Query` on `chatId` with default ascending sort key order returns activities in chronological order without any additional index or timestamp attribute in the key.
2. **26 characters vs 36.** ULIDs are more compact than UUIDs (26 chars in Crockford Base32 vs 36 chars with dashes).
3. **Time-encoded.** The first 10 characters encode a 48-bit millisecond Unix timestamp. This means you can extract the creation time from the ULID itself.
4. **No hot partition risk.** The random component (80 bits) ensures uniqueness even at high throughput within the same millisecond.
5. **DynamoDB string sort keys sort lexicographically.** ULIDs naturally sort correctly as strings because Crockford Base32 preserves byte order.

**Comparison:**

| Property | UUIDv4 | UUIDv7 | ULID |
|----------|--------|--------|------|
| Time-ordered | No | Yes | Yes |
| Lexicographic sort = time sort | No | No (hex encoding) | **Yes** |
| Length | 36 chars | 36 chars | 26 chars |
| Native JS support | `crypto.randomUUID()` | No | Library needed |
| DynamoDB string SK friendly | Poor | Poor | **Excellent** |

#### Recommended Library: `ulidx`

The original `ulid` npm package is unmaintained and has unresolved compatibility issues. **`ulidx`** is the active successor:

- Written entirely in TypeScript with full type exports
- Provides both ESM and CommonJS outputs (compatible with the project's ESM setup)
- Uses `crypto.randomBytes` on Node.js for cryptographically secure randomness
- 129k+ weekly downloads, actively maintained
- Supports monotonic ULID generation for strict sub-millisecond ordering

**Installation:**

```bash
pnpm add ulidx
```

**Usage in the worker handler:**

```typescript
import { ulid } from "ulidx";

// Generate a ULID with the current timestamp
const activityId = ulid();
// Example: "01HQJZ7B4Z0J5M3RGT8X4K6N9P"

// Generate a ULID seeded with a specific timestamp (useful for backdating)
const activityIdFromMessage = ulid(messageTimestamp);
```

**Monotonic factory (if generating multiple ULIDs in the same millisecond):**

```typescript
import { monotonicFactory } from "ulidx";

const generateUlid = monotonicFactory();

// Even within the same millisecond, these are strictly ordered
const id1 = generateUlid(); // 01HQJZ7B4Z0J5M3RGT8X4K6N9P
const id2 = generateUlid(); // 01HQJZ7B4Z0J5M3RGT8X4K6N9Q (incremented)
```

For this project, the simple `ulid()` function is sufficient. The worker processes messages one at a time (batch size 1), so sub-millisecond collisions within the same Lambda invocation are not a concern. The monotonic factory would only be needed if batch processing multiple messages in a single invocation, which is not the current design.

#### Gotchas with ULID in DynamoDB

1. **String type, not number.** ULIDs must be stored as DynamoDB String (`S`) attributes. This is already the plan (`activityId: String` as SK).
2. **Timestamp precision.** ULIDs encode millisecond precision. If you need to query activities by exact timestamp range, use the separate `timestamp` attribute (Number, Unix ms) rather than parsing the ULID.
3. **Seeded vs current time.** For activity logging, seed the ULID with the message's original timestamp (`ulid(messageTimestamp)`) rather than `ulid()` (current time). This ensures the ULID's embedded time reflects when the activity happened, not when the worker processed it. This is important because SQS processing may be delayed.
4. **No built-in decoding in ulidx for time extraction.** `ulidx` provides `decodeTime(ulid)` to extract the timestamp from a ULID, which can be useful for debugging. However, always store `timestamp` as a separate attribute for queries -- do not rely on ULID decoding for query logic.

#### Recommended Pattern for Activity ID Generation

```typescript
import { ulid } from "ulidx";

function createActivityId(messageTimestamp: number): string {
  // Seed ULID with the original message timestamp so the embedded time
  // reflects when the activity occurred, not when the worker processed it.
  return ulid(messageTimestamp);
}
```

---

### 2. Atomic Counter Increment (Response Rate Limiting)

#### The Upsert Pattern

DynamoDB's `UpdateItem` operation naturally performs an upsert: if the item does not exist, it creates it. Combined with the `ADD` action in an `UpdateExpression`, this provides an atomic counter that initializes to 1 on first call and increments on subsequent calls -- all in a single operation with no conditional logic needed.

#### How `ADD` Works

From the DynamoDB documentation:

- If the item **does not exist**, `UpdateItem` creates a new item with the specified key and sets the counter to the increment value.
- If the item **exists but the attribute does not**, `ADD` creates the attribute and sets it to the increment value.
- If the item **exists and the attribute exists**, `ADD` atomically increments the value.

This is exactly the upsert behavior needed for `response_counters`.

#### Concurrency Safety

DynamoDB serializes all `UpdateItem` calls for the same item (same PK+SK). Multiple concurrent Lambda invocations incrementing the counter for the same chat on the same day will never lose updates. Each `ADD` operation is atomic at the item level. There is no read-modify-write race condition.

**Important caveat:** Atomic counters are **not idempotent**. If a Lambda retries (e.g., due to SQS redelivery), the counter will be incremented again. For the response rate limiter, this is acceptable per the PRD: "Eventual consistency acceptable -- slightly exceeding 3 is tolerable, systematic over-responding is not" (Phase 2 PRD, Section 9).

#### Implementation with AWS SDK v3

The existing codebase uses `@aws-sdk/client-dynamodb` (low-level client with explicit marshalling), not `@aws-sdk/lib-dynamodb` (document client). To stay consistent, the examples below use the low-level client.

**Increment counter (upsert):**

```typescript
import {
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

async function incrementResponseCount(
  chatId: string,
  dateStr: string, // YYYY-MM-DD in Stockholm timezone
): Promise<number> {
  // TTL: 7 days from now, in Unix epoch seconds
  const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  const result = await client.send(
    new UpdateItemCommand({
      TableName: process.env.RESPONSE_COUNTERS_TABLE_NAME,
      Key: {
        chatId: { S: chatId },
        date: { S: dateStr },
      },
      UpdateExpression:
        "ADD #count :inc SET #updatedAt = :now, #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: {
        "#count": "count",
        "#updatedAt": "updatedAt",
        "#ttl": "ttl",
      },
      ExpressionAttributeValues: {
        ":inc": { N: "1" },
        ":now": { S: new Date().toISOString() },
        ":ttl": { N: String(ttl) },
      },
      ReturnValues: "UPDATED_NEW",
    }),
  );

  return Number(result.Attributes?.count?.N ?? "0");
}
```

**Key details of this implementation:**

1. `ADD #count :inc` -- atomically increments `count` by 1. If the item or attribute does not exist, it initializes to 1.
2. `SET #updatedAt = :now` -- always updates the timestamp to track when the counter was last touched.
3. `SET #ttl = if_not_exists(#ttl, :ttl)` -- sets the TTL attribute only when creating a new item. This prevents extending the TTL on every increment (the item should expire 7 days after the date it represents, not 7 days after the last update). Note: an alternative approach is to compute TTL from the date string directly (see Section 4).
4. `ReturnValues: "UPDATED_NEW"` -- returns the new count value so the caller can check if the limit is exceeded.
5. `#count` uses `ExpressionAttributeNames` because `count` is a DynamoDB reserved word.

**Check counter before responding:**

```typescript
import { GetItemCommand } from "@aws-sdk/client-dynamodb";

async function getResponseCount(
  chatId: string,
  dateStr: string,
): Promise<number> {
  const result = await client.send(
    new GetItemCommand({
      TableName: process.env.RESPONSE_COUNTERS_TABLE_NAME,
      Key: {
        chatId: { S: chatId },
        date: { S: dateStr },
      },
      ProjectionExpression: "#count",
      ExpressionAttributeNames: { "#count": "count" },
      ConsistentRead: true,
    }),
  );

  return Number(result.Item?.count?.N ?? "0");
}
```

**Note on `ConsistentRead: true`:** Since the counter may have been incremented milliseconds ago by another Lambda invocation, using consistent reads ensures we see the latest value. Without it, DynamoDB's eventual consistency could return a stale count, allowing the bot to exceed its daily limit more often.

#### Check-Then-Increment vs Increment-Then-Check

There are two approaches:

**Option A: Check-then-increment** (recommended)
1. `GetItem` to read current count
2. If count >= 3, suppress response
3. If count < 3, send response, then `UpdateItem` to increment

**Option B: Increment-then-check**
1. `UpdateItem` with `ADD` and `ReturnValues: "UPDATED_NEW"`
2. If returned count > 3, suppress response (counter already incremented)
3. This wastes an increment when the cap is reached

**Recommendation:** Option A (check-then-increment). It avoids unnecessary writes on days when the cap is already reached. The race condition window (two Lambdas both read count=2, both proceed to respond) is acceptable per the PRD's "slightly exceeding 3 is tolerable" guidance.

---

### 3. Stockholm Timezone Handling

#### The Problem

The daily response counter resets at midnight in Europe/Stockholm time. Stockholm observes:
- **CET (Central European Time):** UTC+1 during winter (late October to late March)
- **CEST (Central European Summer Time):** UTC+2 during summer (late March to late October)

In 2026:
- DST starts: Sunday, March 29, 2026 at 02:00 CET -> 03:00 CEST
- DST ends: Sunday, October 25, 2026 at 03:00 CEST -> 02:00 CET

A hardcoded UTC offset will produce wrong dates twice a year during the DST transition.

#### Recommended Approach: `Intl.DateTimeFormat` with `formatToParts`

The built-in `Intl.DateTimeFormat` API handles DST automatically and requires **zero dependencies**. It uses the ICU timezone database bundled with Node.js, which is kept current by the Node.js runtime.

```typescript
/**
 * Get the current date string in YYYY-MM-DD format for Europe/Stockholm timezone.
 * Automatically handles CET/CEST (DST) transitions.
 */
function getStockholmDateString(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // en-CA locale produces YYYY-MM-DD format natively
  return formatter.format(now);
}

// Examples:
// Winter (CET, UTC+1): new Date("2026-01-15T23:30:00Z") -> "2026-01-16"
// Summer (CEST, UTC+2): new Date("2026-07-15T22:30:00Z") -> "2026-07-16"
// DST boundary: new Date("2026-03-29T00:30:00Z") -> "2026-03-29" (still CET)
// DST boundary: new Date("2026-03-29T01:30:00Z") -> "2026-03-29" (now CEST)
```

**Why `en-CA` locale?** The Canadian English locale formats dates as `YYYY-MM-DD` natively, matching ISO 8601. This avoids manual string manipulation.

**Alternative: `formatToParts` for maximum reliability:**

```typescript
function getStockholmDateString(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (type: string) =>
    parts.find((p) => p.type === type)!.value;

  return `${get("year")}-${get("month")}-${get("day")}`;
}
```

This approach is locale-independent because it extracts parts by type, not by position. However, the `en-CA` approach is simpler and equally reliable for the foreseeable future.

#### Quiet Hours Check

The PRD specifies quiet hours from 22:00 to 07:00 Europe/Stockholm. This also uses `Intl.DateTimeFormat`:

```typescript
function getStockholmHour(now: Date = new Date()): number {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Stockholm",
    hour: "numeric",
    hour12: false,
  }).format(now);

  return Number(hourStr);
}

function isQuietHours(now: Date = new Date()): boolean {
  const hour = getStockholmHour(now);
  return hour >= 22 || hour < 7;
}
```

#### Comparison of Approaches

| Approach | DST Handling | Dependencies | Bundle Impact | Reliability |
|----------|-------------|--------------|---------------|-------------|
| **`Intl.DateTimeFormat`** (recommended) | Automatic | None | 0 bytes | Excellent -- uses Node.js ICU data |
| `date-fns-tz` | Automatic | ~15 KB | Small | Good -- well maintained |
| `luxon` | Automatic | ~70 KB | Large | Good -- overkill for this use case |
| `TZ` env variable | Automatic | None | 0 bytes | Risky -- global state, affects all date ops |
| Manual UTC offset | **No** | None | 0 bytes | **Broken during DST transitions** |

**Recommendation:** Use `Intl.DateTimeFormat` with no additional dependencies. It is built into Node.js 22, handles DST transitions automatically, and adds zero bytes to the Lambda bundle. The `TZ` environment variable approach is tempting but risky -- it changes the global timezone for the entire Lambda execution environment, which could cause subtle bugs if any code assumes UTC.

#### When Does the Counter "Reset"?

The counter does not literally reset. Each day gets a new DynamoDB item with SK `date = "YYYY-MM-DD"` in Stockholm time. When midnight passes in Stockholm, the date string changes and subsequent counter reads/writes target a new item that does not exist yet, effectively resetting the count to 0. Old items are cleaned up by TTL.

---

### 4. TTL Configuration

#### How DynamoDB TTL Works

- TTL is set as an attribute on each item containing a Unix epoch timestamp **in seconds** (not milliseconds).
- DynamoDB periodically scans for expired items and deletes them at no cost (no WCU consumed).
- Deletion is **not instant** -- items may persist for up to 48 hours after expiry, though typically deleted within minutes.
- Expired items still appear in queries and scans until physically deleted. If precision matters, add a filter expression: `#ttl > :now`.
- TTL deletes do not count toward provisioned/on-demand write capacity.

#### TTL Attribute for `response_counters`

The TTL value should be computed from the date the counter represents, not from "now":

```typescript
/**
 * Calculate TTL for a response counter item.
 * The item expires 7 days after the date it represents.
 *
 * @param dateStr - Date string in YYYY-MM-DD format (Stockholm timezone)
 * @returns Unix epoch seconds for TTL attribute
 */
function calculateCounterTtl(dateStr: string): number {
  // Parse the date as midnight UTC (close enough for TTL purposes)
  const date = new Date(`${dateStr}T00:00:00Z`);
  const sevenDaysInSeconds = 7 * 24 * 60 * 60;
  return Math.floor(date.getTime() / 1000) + sevenDaysInSeconds;
}
```

**Why compute from the date string, not `Date.now()`?** If we used `Date.now() + 7 days`, items created late on a given day would expire later than items created early on the same day. Computing from the date string ensures all items for the same date expire at the same time, which is cleaner.

#### Updated Increment Function with Date-Based TTL

```typescript
async function incrementResponseCount(
  chatId: string,
  dateStr: string,
): Promise<number> {
  const ttl = calculateCounterTtl(dateStr);

  const result = await client.send(
    new UpdateItemCommand({
      TableName: process.env.RESPONSE_COUNTERS_TABLE_NAME,
      Key: {
        chatId: { S: chatId },
        date: { S: dateStr },
      },
      UpdateExpression:
        "ADD #count :inc SET #updatedAt = :now, #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: {
        "#count": "count",
        "#updatedAt": "updatedAt",
        "#ttl": "ttl",
      },
      ExpressionAttributeValues: {
        ":inc": { N: "1" },
        ":now": { S: new Date().toISOString() },
        ":ttl": { N: String(ttl) },
      },
      ReturnValues: "UPDATED_NEW",
    }),
  );

  return Number(result.Attributes?.count?.N ?? "0");
}
```

#### CDK TTL Configuration

TTL is enabled at the table level by specifying the attribute name:

```typescript
const responseCountersTable = new dynamodb.Table(this, "ResponseCountersTable", {
  tableName: "homeops-response-counters",
  partitionKey: { name: "chatId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "date", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: "ttl",        // <-- enables TTL on the "ttl" attribute
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
```

**No additional runtime configuration needed.** Once `timeToLiveAttribute` is set in CDK, DynamoDB automatically scans for and deletes items where the `ttl` attribute value is in the past.

---

### 5. GSI Design Validation

#### Query Pattern Analysis

The Phase 2 PRD defines two query patterns for activities:

1. **List activities for a chat, ordered by time** -- Served by the base table directly: `Query(PK = chatId)` with default ascending sort on `activityId` (ULID, which is time-ordered).
2. **List activities for a user, ordered by time** -- Requires the `userId-timestamp-index` GSI: `Query(PK = userId, SK begins_with or between on timestamp)`.
3. **Link back to raw message** -- The `messageId` attribute is stored on each activity item. No index needed; this is a point lookup on `homeops-messages` when the raw message is needed.

#### GSI Design: `userId-timestamp-index`

| GSI Property | Value | Rationale |
|-------------|-------|-----------|
| Index name | `userId-timestamp-index` | Descriptive, matches the PK-SK pattern |
| Partition key | `userId` (Number) | Telegram user IDs are numeric |
| Sort key | `timestamp` (Number, Unix ms) | Enables time-range queries and chronological ordering |
| Projection | `ALL` | See analysis below |

#### Projection Type Analysis

| Projection | Storage Cost | Write Cost | Read Pattern |
|-----------|-------------|------------|-------------|
| `KEYS_ONLY` | Minimal (~100 bytes/item) | 1 WCU/item (minimum) | Must fetch base table for attributes; double the read cost |
| `INCLUDE` (specific attrs) | Moderate | 1 WCU/item (items < 1KB) | No base table fetch if projected attrs suffice |
| `ALL` | Full item duplicated | 1 WCU/item (items < 1KB) | No base table fetch ever |

**Recommendation: `ALL` projection.**

Rationale:
1. **Activity items are small (~0.5 KB).** At this size, the minimum 1 WCU/write charge applies regardless of projection type. Projecting `ALL` vs `KEYS_ONLY` costs the same in write capacity.
2. **Storage is negligible.** At ~1,000 activities/month, even doubling storage to ~1 MB/month is well within the 25 GB free tier.
3. **Avoids base table fetches.** With `KEYS_ONLY`, every query on the GSI that needs activity details (type, activity name, effort, confidence) requires a separate `GetItem` on the base table for each result. At household scale this is fine, but it doubles read latency and code complexity for zero cost savings.
4. **"Who did what" queries need all attributes.** The primary use case for this GSI is displaying a user's activity history, which requires type, activity, effort, and confidence -- essentially all attributes.

#### GSI Key Type Consideration

The `userId` attribute is a Telegram user ID (Number type). In the activities table, `userId` is stored as a Number. The GSI partition key should match: `type: dynamodb.AttributeType.NUMBER`.

Similarly, `timestamp` is stored as Number (Unix ms), so the GSI sort key is `type: dynamodb.AttributeType.NUMBER`.

#### Validation Summary

The proposed GSI design is **correct and well-suited** for the query patterns:

- Query pattern 2 ("list activities for a user ordered by time") maps directly to `GSI PK = userId, SK sorted by timestamp`.
- Time-range queries (e.g., "activities in the last 7 days") use `KeyConditionExpression: "userId = :uid AND #ts BETWEEN :start AND :end"`.
- The `ALL` projection ensures all needed attributes are available without base table fetches.
- Cost impact at household scale: effectively $0/month.

---

### 6. CDK Table Definitions

#### Complete CDK Construct for Phase 2 Tables

The following construct defines both new tables and can be added alongside the existing `MessageStore` construct. It follows the same patterns established in Phase 1: `PAY_PER_REQUEST` billing, `DESTROY` removal policy for development, and explicit table naming.

```typescript
// infra/constructs/activity-store.ts
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export class ActivityStore extends Construct {
  public readonly activitiesTable: dynamodb.Table;
  public readonly responseCountersTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Activities table: stores classified chore/recovery events
    this.activitiesTable = new dynamodb.Table(this, "ActivitiesTable", {
      tableName: "homeops-activities",
      partitionKey: {
        name: "chatId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "activityId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // GSI for "who did what" queries: activities by user, ordered by time
    this.activitiesTable.addGlobalSecondaryIndex({
      indexName: "userId-timestamp-index",
      partitionKey: {
        name: "userId",
        type: dynamodb.AttributeType.NUMBER,
      },
      sortKey: {
        name: "timestamp",
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Response counters table: daily response count per chat
    this.responseCountersTable = new dynamodb.Table(
      this,
      "ResponseCountersTable",
      {
        tableName: "homeops-response-counters",
        partitionKey: {
          name: "chatId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: {
          name: "date",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: "ttl",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
  }
}
```

#### Stack Integration

Update the existing `HomeOpsStack` in `/Users/martinnordlund/homeOps/infra/stack.ts` to include the new construct:

```typescript
// In infra/stack.ts, add:
import { ActivityStore } from "./constructs/activity-store.js";

// Inside the constructor:
const activityStore = new ActivityStore(this, "ActivityStore");

// Pass tables to the MessageProcessing construct (which contains the worker):
const processing = new MessageProcessing(this, "MessageProcessing", {
  messagesTable: store.messagesTable,
  activitiesTable: activityStore.activitiesTable,
  responseCountersTable: activityStore.responseCountersTable,
});
```

#### Lambda Permissions

The worker Lambda needs permissions for the new tables. Update `MessageProcessing` to grant:

```typescript
// In infra/constructs/message-processing.ts

// Activities table: write activities + query by chat
activityStore.activitiesTable.grant(
  worker,
  "dynamodb:PutItem",
  "dynamodb:Query",
);

// Activities GSI: query by user
activityStore.activitiesTable.grant(
  worker,
  "dynamodb:Query",
);
// Note: GSI permissions are granted through the base table.
// The grant above already covers GSI queries because DynamoDB GSI
// queries use the base table's ARN with an /index/* suffix.
// CDK's .grant() on a Table includes the index ARN automatically.

// Response counters table: read count + atomic increment
activityStore.responseCountersTable.grant(
  worker,
  "dynamodb:GetItem",
  "dynamodb:UpdateItem",
);

// Messages table: Query for fast conversation detection
// Phase 1 already grants PutItem; add Query:
store.messagesTable.grant(worker, "dynamodb:Query");
```

**Important note on GSI permissions:** When you call `.grant()` on a CDK `Table`, it generates an IAM policy that covers both the table ARN (`arn:aws:dynamodb:...:table/homeops-activities`) and all its indexes (`arn:aws:dynamodb:...:table/homeops-activities/index/*`). A single `grant` call is sufficient for both base table and GSI operations.

#### Environment Variables

Pass the new table names to the worker Lambda:

```typescript
environment: {
  MESSAGES_TABLE_NAME: props.messagesTable.tableName,
  ACTIVITIES_TABLE_NAME: props.activitiesTable.tableName,
  RESPONSE_COUNTERS_TABLE_NAME: props.responseCountersTable.tableName,
},
```

---

### 7. Fast Conversation Detection Query

#### Requirement

Before responding, the bot must check if 3+ messages from other users arrived in the last 60 seconds in the same chat. If so, the conversation is "fast-moving" and the bot should suppress its response.

#### Raw Messages Table Schema (Phase 1)

From `/Users/martinnordlund/homeOps/infra/constructs/message-store.ts`:

```
Table: homeops-messages
PK: chatId (String)
SK: messageId (Number) -- Telegram message ID, monotonically increasing per chat
Attributes: userId (Number), timestamp (Number, Unix ms), ...
```

The sort key is `messageId` (Number), not `timestamp`. Telegram message IDs are monotonically increasing within a chat, so they serve as a natural chronological ordering. However, they are not Unix timestamps -- you cannot use `BETWEEN` on `messageId` to query a time range.

#### Query Strategy

Since we cannot query by time range on the sort key, the most efficient approach is:

1. Query the last N messages in the chat (reverse order, limited).
2. Filter in application code to count messages from other users within the last 60 seconds.

```typescript
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

/**
 * Check if the conversation is "fast-moving" by counting recent messages
 * from other users in the same chat.
 *
 * @param chatId - The chat to check
 * @param currentUserId - The bot's user ID or the current message sender's user ID
 * @param nowMs - Current time in Unix milliseconds
 * @returns true if 3+ messages from other users arrived in the last 60 seconds
 */
async function isConversationFast(
  chatId: string,
  currentUserId: number,
  nowMs: number,
): Promise<boolean> {
  const sixtySecondsAgo = nowMs - 60_000;

  // Query the most recent messages in this chat (reverse order)
  // Limit to 10 -- if the last 10 messages don't span 60 seconds,
  // we have enough data. If they do, we still have enough to count.
  const result = await client.send(
    new QueryCommand({
      TableName: process.env.MESSAGES_TABLE_NAME,
      KeyConditionExpression: "chatId = :chatId",
      ExpressionAttributeValues: {
        ":chatId": { S: chatId },
      },
      ScanIndexForward: false, // Descending order (most recent first)
      Limit: 10,
      ProjectionExpression: "userId, #ts",
      ExpressionAttributeNames: { "#ts": "timestamp" },
    }),
  );

  if (!result.Items) return false;

  // Count messages from OTHER users within the last 60 seconds
  let recentOtherUserMessages = 0;
  for (const item of result.Items) {
    const ts = Number(item.timestamp?.N ?? "0");
    const userId = Number(item.userId?.N ?? "0");

    if (ts < sixtySecondsAgo) break; // Older than 60s, stop counting
    if (userId !== currentUserId) {
      recentOtherUserMessages++;
    }
  }

  return recentOtherUserMessages >= 3;
}
```

#### Why This Works Efficiently

1. **`ScanIndexForward: false`** reads the partition in descending sort key order. Since `messageId` is monotonically increasing, this returns the most recent messages first.
2. **`Limit: 10`** caps the read to at most 10 items. This is a single DynamoDB read operation consuming at most 10 items worth of RCU (well under 1 KB per item, so ~1-2 RCU total with eventual consistency).
3. **`ProjectionExpression`** limits the returned attributes to only `userId` and `timestamp`, reducing data transfer.
4. **Application-level filtering** counts messages from other users within the 60-second window. We break early when we hit a message older than 60 seconds.

#### Alternative: Add a GSI with Timestamp Sort Key

Adding a `chatId-timestamp-index` GSI to the messages table would allow querying by time range directly:

```
GSI PK: chatId, SK: timestamp
Query: chatId = :chatId AND timestamp > :sixtySecondsAgo
```

**Recommendation: Do not add this GSI.** The extra infrastructure (GSI write amplification on the highest-volume table) is not justified when querying the last 10 items and filtering in application code works perfectly for this use case. The messages table processes 50-200 messages/day; querying the last 10 and filtering is negligible.

#### Edge Case: Bot's Own Messages

The current raw messages table only stores messages ingested from the Telegram webhook. If the bot sends a response, that response is not stored in the messages table (the bot calls `sendMessage` directly, bypassing the ingestion pipeline). Therefore, the bot's own responses will not appear in this query, which is the correct behavior -- we want to count messages from "other users", excluding the bot.

However, the `currentUserId` parameter should be the **sending user's** Telegram ID (the person whose message triggered the classification), not the bot's ID. We want to count messages from users *other than the sender*, since the sender's message is the one being classified.

---

## Recommendation

### Approach Summary

| Area | Recommendation |
|------|---------------|
| ULID library | `ulidx` -- TypeScript-native, ESM-compatible, actively maintained |
| ULID seeding | Seed with message timestamp: `ulid(messageTimestamp)` |
| Atomic counter | `UpdateItem` with `ADD` expression -- natural upsert, concurrency-safe |
| Counter check | Check-then-increment (read first, write after send) |
| Timezone | `Intl.DateTimeFormat` with `en-CA` locale -- zero dependencies, DST-safe |
| TTL | Compute from date string, store as `ttl` (Unix seconds), 7-day expiry |
| GSI projection | `ALL` -- items are small, avoids base table fetches |
| CDK construct | New `ActivityStore` construct with both tables |
| Fast conversation | Query last 10 messages, filter in application code |
| SDK style | Stay with `@aws-sdk/client-dynamodb` (low-level) for consistency with Phase 1 |

### New Dependency

One new dependency: `ulidx`. This is a small, well-maintained library (~5 KB minified) that will be tree-shaken by esbuild into the worker Lambda bundle.

### No New Dependencies for Timezone

`Intl.DateTimeFormat` is built into Node.js 22. No `date-fns-tz`, `luxon`, or `moment-timezone` needed.

## Trade-offs

| Decision | What You Give Up |
|----------|-----------------|
| `ulidx` dependency | One more npm package to maintain; though it is tiny and stable |
| `ulid(messageTimestamp)` seeding | If SQS delivers messages out of order, activities may not be in strict processing order (but will be in message-time order, which is correct) |
| Check-then-increment | Tiny race window where two Lambdas both read count=2 and both respond (acceptable per PRD) |
| `Intl.DateTimeFormat` | Relies on Node.js ICU timezone data being up-to-date (Node.js 22 includes full ICU by default) |
| `ALL` GSI projection | Doubles storage for activity items in the GSI (~0.5 KB/item duplicated); negligible at household scale |
| No timestamp GSI on messages | Fast conversation detection does a 10-item scan+filter instead of a precise time-range query; negligible overhead |
| Low-level SDK (`client-dynamodb`) | More verbose than `lib-dynamodb` document client; but consistent with existing codebase |

## Open Questions

1. **Should `ulidx` be seeded with message timestamp or current time?** This document recommends message timestamp to preserve chronological ordering even when SQS processing is delayed. However, if the team prefers ULIDs to reflect processing time (when the activity was *classified*), use `ulid()` without a seed. The `timestamp` attribute stores the original message time regardless.

2. **Should expired TTL items be filtered in queries?** DynamoDB may take up to 48 hours to physically delete expired items. If the response counter query reads an item from 8 days ago (TTL expired but not yet deleted), the date SK mismatch naturally prevents it from interfering -- the query uses today's date string as the SK. No filter expression needed for this table.

3. **Should the `ActivityStore` construct be a separate file or merged with `MessageStore`?** This document suggests a separate construct for clarity and to minimize changes to existing Phase 1 code. An alternative is to add the Phase 2 tables to `MessageStore` and rename it to `DataStore`. The decision is organizational, not technical.

4. **Naming: `homeops-activities` vs using the `homeops` single-table?** The Phase 1 research recommended a hybrid approach with a shared `homeops` single-table for non-message entities. The Phase 2 PRD specifies a dedicated `activities` table. This document follows the PRD. If the team wants to use the existing `homeops` single-table instead, the activity items would use `PK = CHAT#<chatId>`, `SK = ACTIVITY#<ulid>` -- all the same patterns apply, just with prefixed keys. The `response_counters` could similarly be items in the `homeops` table with `PK = COUNTER#<chatId>`, `SK = <date>`.

5. **Should `@aws-sdk/lib-dynamodb` be introduced?** The document client provides cleaner syntax (native JS objects instead of `{ S: "..." }` marshalling). However, introducing it now would create inconsistency with the Phase 1 worker code. Recommendation: defer to a separate code cleanup task or introduce it when the worker is refactored for Phase 2.
