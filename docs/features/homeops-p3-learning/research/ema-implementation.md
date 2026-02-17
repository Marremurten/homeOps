# EMA Implementation Patterns for Effort & Engagement Tracking

**Feature:** homeops-p3-learning
**Research Question:** EMA formula selection, cold-start handling, numeric stability, effort encoding, DynamoDB atomic updates, and metric-type suitability for Phase 3 learning system
**Date:** 2026-02-17

## Summary

Exponential Moving Average (EMA) is well-suited for tracking effort scores (1-3 scale) and ignore rates (binary 0/1) in a serverless household chore bot. The PRD-specified smoothing factors (alpha=0.3 for effort, alpha=0.2 for ignore rate) are reasonable defaults. However, DynamoDB's UpdateExpression does not support multiplication, which means EMA cannot be computed atomically in a single UpdateItem call -- a read-then-conditional-write pattern with optimistic locking is required instead. This document covers all seven research areas and provides concrete TypeScript implementation patterns consistent with the existing codebase.

## Findings

### 1. EMA Formula & Smoothing Factor Analysis

#### The Formula

```
EMA_new = alpha * current_value + (1 - alpha) * EMA_previous
```

This is equivalent to:

```
EMA_new = EMA_previous + alpha * (current_value - EMA_previous)
```

The second form is useful conceptually: the EMA moves toward the current observation by a fraction `alpha` of the distance between them.

#### Key Metrics for Alpha Values

The **half-life** (number of observations for old data weight to halve) is:

```
half_life = log(0.5) / log(1 - alpha)
```

The **effective window** (approximate number of observations contributing meaningfully, where weight > 1/e) is:

```
effective_window = 1 / alpha
```

The **number of observations for an initial value's weight to drop below a threshold** (e.g., 5%) is:

```
n = log(threshold) / log(1 - alpha)
```

#### Alpha = 0.3 (Effort Tracking)

| Metric | Value |
|--------|-------|
| Half-life | ~1.94 observations |
| Effective window | ~3.3 observations |
| 95% decay (initial has <5% weight) | ~8.4 observations |
| 99% decay (initial has <1% weight) | ~12.9 observations |

**Practical meaning:** After ~2 chore events, the initial observation contributes less than half the EMA. After ~9 events, the initial observation is nearly irrelevant. At household scale (perhaps 2-5 chores per user per week), this means the EMA "adapts" within 1-4 weeks.

**Concrete example (effort scale 1-3):**

Starting from first observation = 1 (low effort):

| Observation # | Input | EMA (alpha=0.3) |
|---------------|-------|-----------------|
| 1 | 1 (low) | 1.000 |
| 2 | 2 (medium) | 1.300 |
| 3 | 2 (medium) | 1.510 |
| 4 | 3 (high) | 1.957 |
| 5 | 2 (medium) | 1.970 |
| 6 | 2 (medium) | 1.979 |
| 7 | 2 (medium) | 1.985 |
| 8 | 2 (medium) | 1.990 |

After 8 observations with mostly medium effort, the EMA converges to ~2.0 regardless of the initial low-effort start. This is reasonable responsiveness for household chore tracking.

**Assessment:** Alpha = 0.3 is a solid default. It balances responsiveness (adapts within a few observations) with stability (does not overreact to a single outlier). For a 1-3 scale with infrequent observations (a few per week), this is appropriate. A lower alpha (e.g., 0.1) would require ~30 observations to forget the initial value, which could take months at household scale -- too slow.

#### Alpha = 0.2 (Ignore Rate)

| Metric | Value |
|--------|-------|
| Half-life | ~3.1 observations |
| Effective window | ~5 observations |
| 95% decay | ~13.4 observations |
| 99% decay | ~20.6 observations |

**Practical meaning:** The ignore rate is more conservative -- it takes ~3 interactions before old data loses half its weight, and ~13 interactions before the initial value is negligible. This makes sense for a behavioral metric where false positives (wrongly suppressing responses) are more costly than being slow to adapt.

**Concrete example (binary 0/1 ignore rate):**

Starting from first observation = 0 (user responded):

| Observation # | Input | EMA (alpha=0.2) |
|---------------|-------|-----------------|
| 1 | 0 (responded) | 0.000 |
| 2 | 1 (ignored) | 0.200 |
| 3 | 1 (ignored) | 0.360 |
| 4 | 1 (ignored) | 0.488 |
| 5 | 1 (ignored) | 0.590 |
| 6 | 1 (ignored) | 0.672 |
| 7 | 1 (ignored) | 0.738 |

It takes 7 consecutive ignores from a "clean" start to cross the 0.7 threshold. Combined with the PRD requirement of 10+ data points before adaptation, this provides a strong guard against premature behavior changes.

**Assessment:** Alpha = 0.2 is appropriate for ignore rate. The slower adaptation is intentional -- you want strong evidence before suppressing bot responses for a user.

---

### 2. Cold-Start Handling

#### PRD Approach: First Observation = Initial EMA

The PRD specifies: "Cold start: First observation becomes the initial EMA (no smoothing applied)." This means:

```typescript
if (sampleCount === 0) {
  ema = currentValue; // No smoothing
} else {
  ema = alpha * currentValue + (1 - alpha) * previousEma;
}
```

#### Analysis of This Approach

**Pros:**
- Simple to implement and reason about
- No dependency on external data (global averages, etc.)
- The first observation is the best available information
- With alpha = 0.3, the initial bias decays quickly (~9 observations)

**Cons:**
- If the first observation is an outlier (e.g., user's first chore was unusually high effort), the EMA is biased until enough subsequent observations dilute it
- For binary metrics like ignore rate, the first observation locks the EMA at 0 or 1 until subsequent data arrives

#### Alternative: Use a Prior (Global Average)

Instead of using the first observation directly, initialize with a "prior" value:

```typescript
const EFFORT_PRIOR = 2.0;  // Medium effort as default
const IGNORE_PRIOR = 0.3;  // Assume ~30% ignore rate

if (sampleCount === 0) {
  ema = alpha * currentValue + (1 - alpha) * prior;
} else {
  ema = alpha * currentValue + (1 - alpha) * previousEma;
}
```

**Assessment:** Over-engineered for this use case. The prior approach is useful in recommendation systems with millions of users where good priors exist. With a small household (2-5 people), there is no meaningful "global average" to learn from. The simple first-observation approach is correct.

#### Early-Stage Volatility

With very few observations, the EMA can be volatile:

| Observations | Input Sequence | EMA (alpha=0.3) |
|-------------|----------------|-----------------|
| 1 | [3] | 3.000 |
| 2 | [3, 1] | 2.400 |
| 3 | [3, 1, 1] | 1.980 |

After 2 observations, the EMA swings from 3.0 to 2.4 -- a 20% drop. This is expected and acceptable because:

1. **The PRD already requires 10+ data points before behavioral adaptation** (PRD line 122). The EMA value is informational until the threshold is met.
2. **Effort EMA is used as context for OpenAI, not as an override** (PRD line 103). A volatile early EMA will not cause bad classifications.

#### Recommendation

**Use the PRD's approach (first observation = initial EMA).** It is simple, correct, and the 10-data-point threshold guards against acting on unreliable early values. No minimum sample count is needed beyond what the PRD already specifies for behavioral adaptation.

---

### 3. Numeric Stability

#### Edge Cases

**Zero observations:** The EMA record does not exist yet in DynamoDB. The code should handle `GetItem` returning no item by treating it as a cold start. There is no "0 observations" EMA value -- the EMA is undefined until the first observation.

**One observation:** The EMA equals the first observed value exactly. No precision issues.

**Repeated identical values:** EMA converges to that value. For example, if every observation is 2, the EMA stabilizes at exactly 2.0 after a few iterations:

```
EMA = 0.3 * 2 + 0.7 * 2 = 2.0  (immediately stable)
```

#### DynamoDB Number Precision

DynamoDB Numbers support up to 38 digits of precision. They are stored internally as variable-length decimal strings, not IEEE 754 floating-point. This means:

- **No binary floating-point rounding errors** in storage. If you write `1.510`, DynamoDB stores exactly `1.510`.
- **JavaScript `Number` (IEEE 754 double) is the weak link.** When computing `0.3 * 2 + 0.7 * 1.0` in JavaScript, the result is `1.3` (exact in this case), but more complex sequences can produce values like `1.9700000000000002`.
- **AWS SDK v3 marshalling:** The low-level client uses `{ N: String(value) }`. JavaScript's `String(1.9700000000000002)` produces `"1.9700000000000002"`, which DynamoDB stores faithfully. On read, `Number("1.9700000000000002")` returns the same IEEE 754 double.

#### Should EMA Be Rounded?

**Yes, round to 4 decimal places before storage.** The effort scale is 1-3 (only 3 distinct input values), and the ignore rate is 0-1 (only 2 distinct input values). More than 4 decimal places of precision provides zero informational value while making values harder to read in logs and the DynamoDB console.

```typescript
function roundEma(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// Examples:
// roundEma(1.9700000000000002) => 1.97
// roundEma(2.3456789) => 2.3457
```

**Rounding before storage also ensures deterministic read-modify-write behavior.** If two concurrent Lambda invocations read the same EMA value, they will both compute from the same rounded base, making optimistic locking comparisons reliable.

---

### 4. Effort Value Encoding

#### Current Encoding (PRD): low=1, medium=2, high=3

This is a linear, evenly-spaced encoding with a range of 2 (3 - 1 = 2).

#### Alternative: Wider Spread (e.g., low=1, medium=3, high=5)

| Property | 1-2-3 | 1-3-5 |
|----------|-------|-------|
| Range | 2 | 4 |
| EMA meaningful precision | ~0.1 distinction | ~0.1 distinction |
| Readable as "effort score" | Intuitive | Less intuitive (what does 3.7 mean?) |
| Maps back to category | 1.0-1.5 = low, 1.5-2.5 = medium, 2.5-3.0 = high | 1.0-2.0 = low, 2.0-4.0 = medium, 4.0-5.0 = high |
| Prompt context clarity | "EMA: 2.1 (between low and medium)" is clear | "EMA: 3.7 (between medium and high)" is less clear |

#### Analysis

The wider spread (1-3-5) does not provide meaningful benefits:

1. **EMA granularity is not the bottleneck.** The EMA is used as context for OpenAI classification, not for precise numeric thresholds. Whether the prompt says "typical effort: 2.1" or "typical effort: 3.7" makes no difference to the model -- both convey "slightly above medium."

2. **Readability matters more than precision.** The 1-2-3 encoding maps directly to the effort enum values, making logs and debugging intuitive: EMA of 1.5 means "between low and medium." An EMA of 3.5 on a 1-5 scale is harder to interpret quickly.

3. **Mapping back to categories is simpler.** With 1-2-3, rounding the EMA to the nearest integer gives the "typical effort level" directly:
   ```typescript
   function typicalEffort(ema: number): "low" | "medium" | "high" {
     if (ema < 1.5) return "low";
     if (ema < 2.5) return "medium";
     return "high";
   }
   ```

4. **Non-linear encodings (log scale, etc.) are overkill.** With only 3 levels and a simple EMA, the encoding does not affect the mathematical properties of the average in any meaningful way.

#### Recommendation

**Keep the PRD encoding: low=1, medium=2, high=3.** It is simple, readable, and sufficient. The effort encoding map should be a constant:

```typescript
const EFFORT_VALUES: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
};
```

---

### 5. DynamoDB Atomic Updates for EMA

#### The Core Problem

The EMA formula requires multiplication:

```
EMA_new = alpha * current + (1 - alpha) * EMA_previous
```

**DynamoDB's UpdateExpression does not support multiplication.** It only supports addition (`+`) and subtraction (`-`) in SET expressions. There is no way to express `SET ema = :alpha * :current + :oneMinusAlpha * ema` in a single UpdateItem call.

This is fundamentally different from the atomic counter pattern used in Phase 2's response counter at `/Users/martinnordlund/homeOps/src/shared/services/response-counter.ts`, which only needs `ADD count :inc`.

#### Approach A: Read-Then-Conditional-Write (Recommended)

Use optimistic locking with `sampleCount` as the version attribute to prevent lost updates:

```typescript
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

interface EmaUpdateParams {
  tableName: string;
  pk: string;           // e.g., "EFFORT#123456"
  sk: string;           // e.g., "diskning"
  currentValue: number; // e.g., 2 for "medium"
  alpha: number;        // e.g., 0.3
}

async function updateEma(params: EmaUpdateParams): Promise<void> {
  const now = new Date().toISOString();

  // Step 1: Read current EMA
  const getResult = await client.send(
    new GetItemCommand({
      TableName: params.tableName,
      Key: {
        pk: { S: params.pk },
        sk: { S: params.sk },
      },
    }),
  );

  if (!getResult.Item) {
    // Cold start: create new record with first observation as EMA
    await client.send(
      new UpdateItemCommand({
        TableName: params.tableName,
        Key: {
          pk: { S: params.pk },
          sk: { S: params.sk },
        },
        UpdateExpression:
          "SET ema = :ema, sampleCount = :one, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(pk)",
        ExpressionAttributeValues: {
          ":ema": { N: String(roundEma(params.currentValue)) },
          ":one": { N: "1" },
          ":now": { S: now },
        },
      }),
    );
    return;
  }

  // Step 2: Compute new EMA client-side
  const previousEma = Number(getResult.Item.ema.N);
  const previousCount = Number(getResult.Item.sampleCount.N);
  const newEma = roundEma(
    params.alpha * params.currentValue + (1 - params.alpha) * previousEma,
  );
  const newCount = previousCount + 1;

  // Step 3: Conditional write (optimistic locking on sampleCount)
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: params.tableName,
        Key: {
          pk: { S: params.pk },
          sk: { S: params.sk },
        },
        UpdateExpression:
          "SET ema = :newEma, sampleCount = :newCount, updatedAt = :now",
        ConditionExpression: "sampleCount = :expectedCount",
        ExpressionAttributeValues: {
          ":newEma": { N: String(newEma) },
          ":newCount": { N: String(newCount) },
          ":expectedCount": { N: String(previousCount) },
          ":now": { S: now },
        },
      }),
    );
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      // Another invocation updated between our read and write.
      // Safe to swallow -- the next event will incorporate both.
      console.warn("EMA update conflict, skipping (will self-correct)");
      return;
    }
    throw error;
  }
}

function roundEma(value: number): number {
  return Math.round(value * 10000) / 10000;
}
```

#### Why Optimistic Locking on `sampleCount` (Not a Separate Version Field)

The `sampleCount` is already a monotonically increasing counter that changes on every update. Using it as the optimistic lock condition avoids adding a separate `version` attribute. If two concurrent Lambda invocations read `sampleCount = 5`, only one will succeed with `ConditionExpression: sampleCount = :5`; the other gets `ConditionalCheckFailedException`.

#### Concurrency Risk Assessment

At household scale with batch size 1 and 50-200 messages/day, concurrent updates to the same user+activity EMA record are extremely rare. Two messages from the same user about the same activity would need to be processed simultaneously by different Lambda invocations. The SQS batch size of 1 and the low throughput make this a near-zero probability event. Even if a conflict occurs, the EMA is self-correcting -- the lost update will be approximately incorporated by the next observation.

#### Approach B: Pre-Compute and SET (No Locking)

```typescript
// Simpler but NOT concurrency-safe
// Step 1: Read current ema
// Step 2: Compute new ema client-side
// Step 3: SET ema = :newEma, sampleCount = sampleCount + :one
// (no ConditionExpression)
```

This avoids the conditional check but has a race condition: if two updates read the same `ema` value, one will be lost. Given the near-zero concurrency probability at household scale, this is acceptable in practice, but the optimistic locking approach costs only one conditional check and provides correctness guarantees.

#### Approach C: Single UpdateItem with Arithmetic Trick

Since DynamoDB supports addition but not multiplication, one could try to express the EMA formula `EMA_new = EMA_old + alpha * (current - EMA_old)` as:

```
SET ema = ema + :delta
```

where `:delta = alpha * (current - EMA_old)`.

But this still requires knowing `EMA_old` to compute `:delta`, so a read is needed anyway. This approach offers no advantage over Approach A and loses the optimistic locking benefit.

#### Recommendation

**Use Approach A (read-then-conditional-write with sampleCount as optimistic lock).** The extra read adds ~5ms latency and costs nothing at this scale. It provides correctness and is consistent with the established DynamoDB patterns in the codebase.

---

### 6. EMA for Different Metric Types

#### Effort EMA (1-3 Scale) -- EMA Is Appropriate

Effort is an ordinal scale with 3 levels mapped to integers. EMA works well because:
- The input values are bounded (1-3), so the EMA stays bounded (1-3)
- The numeric encoding is evenly spaced, so the EMA midpoint (2.0) maps naturally to "medium"
- The EMA provides a meaningful "typical effort" signal for the OpenAI prompt

No special handling needed. Update the EMA immediately after each activity event.

#### Ignore Rate EMA (Binary 0/1) -- EMA Works Well

EMA on binary values is mathematically equivalent to an **exponentially weighted proportion**. The EMA output is bounded [0, 1] and represents a smoothed "probability of ignoring."

**Why EMA works for binary data:**
- Binary input means the EMA never diverges or explodes
- The output naturally represents a rate (0.0 = never ignores, 1.0 = always ignores)
- Alpha = 0.2 provides appropriate smoothing -- a single response after a streak of ignores moves the rate slowly, preventing erratic behavior changes

**How to determine "ignored":**
The PRD defines ignore as "no reply or reaction within 30 minutes" (PRD line 111). This requires a delayed check mechanism:

- **Option 1: Check on next message.** When the bot sends a response, record the timestamp and messageId. When the same user's next message arrives, check if it was a reply to the bot's message within 30 minutes. If not, record ignore=1.
- **Option 2: Scheduled check.** Use EventBridge to trigger a check 30 minutes after each bot response. More accurate but adds infrastructure.
- **Recommended: Option 1.** It is simpler, requires no new infrastructure, and is "close enough" at household scale. The downside is that if a user responds to the bot but then does not send another message for hours, the ignore check is delayed. This is acceptable because the preference adaptation has a 10-data-point threshold anyway.

The timing of the ignore check affects when the EMA is updated. With Option 1, the EMA update for an ignore/response event happens when the *next* message from that user arrives, not at the 30-minute mark.

#### Interaction Frequency (Messages Per Day) -- EMA Is Appropriate with Caveats

The PRD specifies "Messages per day from this user (rolling 7-day average)" (PRD line 113).

**Two options:**

**Option A: Rolling 7-day simple average.** Count messages per day for the last 7 days and divide by 7. Requires storing per-day counts (7 values) and a daily roll-off mechanism.

**Option B: EMA on daily message counts.** Each "day close" (first message of a new day, or a scheduled trigger) computes the previous day's message count and updates the EMA. Alpha = 0.2 gives an effective window of ~5 days, which approximates a 7-day rolling average.

**Recommendation: Option B (EMA) for simplicity.** It requires storing only one number (the EMA), not a 7-day window. The PRD says "rolling 7-day average" but the intent is "recent activity level" -- an EMA with alpha=0.2 captures this well enough. The trigger for updating should be the first message of a new day (detected via Stockholm date change).

```typescript
// On each message, check if the date changed since last update
// If yes, close the previous day's count and update the EMA
async function updateInteractionFrequency(
  userId: string,
  currentDate: string, // Stockholm date YYYY-MM-DD
): Promise<void> {
  // Read current record: { lastDate, dayCount, ema, sampleCount }
  // If lastDate === currentDate: increment dayCount
  // If lastDate !== currentDate:
  //   - Update EMA with dayCount from lastDate
  //   - Reset dayCount to 1 for the new day
  //   - Store currentDate as lastDate
}
```

**Important:** Days with zero messages are tricky. If a user sends 0 messages on a day, there is no trigger to "close" that day. This means the EMA will skip zero-activity days. For household use, this is acceptable -- the metric captures "how active is this user when they are active" rather than including inactive days. The PRD's threshold of "< 1 msg/day" accounts for this: a user who messages on some days but not others will naturally have a low EMA.

#### Response Timing (Active Hours) -- EMA Does NOT Apply

The PRD specifies "Average time-of-day the user is active (hour buckets, rolling 7-day window)" (PRD line 112). This is a distribution, not a scalar -- EMA is not appropriate.

**Recommended approach: Derive from existing PATTERN records.**

The PRD already defines `PATTERN#<chatId>#<userId>` records with `hourOfDayCounts` maps (PRD line 151). These are updated after each activity event. Rather than maintaining a separate `activeTimes` preference metric, derive active hours from the pattern data at query time:

```typescript
function getActiveHours(hourCounts: Record<string, number>): number[] {
  return Object.entries(hourCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([hour]) => Number(hour));
}
```

This avoids duplicating hour-of-day tracking in two places (PATTERN and PREF records).

**Alternative: Decaying hour-of-day counters in a separate record.**

If recency weighting is important (it may be -- the PRD says "rolling 7-day window"), store a map of hour buckets with decay applied on each update:

1. On each message, determine the Stockholm hour (0-23).
2. Read the current hour map.
3. Decay all existing counts by a factor (e.g., multiply by 0.95).
4. Increment the current hour's count by 1.
5. Write back.

After ~20 observations, old data has negligible influence (0.95^20 = 0.36). This is more complex but provides recency-aware active hour tracking.

---

### 7. Practical Recommendations

#### Implementation Pattern (TypeScript)

A clean service module for the effort tracker, consistent with existing codebase patterns in `/Users/martinnordlund/homeOps/src/shared/services/response-counter.ts` and `/Users/martinnordlund/homeOps/src/shared/services/activity-store.ts`:

```typescript
// /src/shared/services/effort-tracker.ts

import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

const EFFORT_VALUES: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function roundEma(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export interface EffortEma {
  ema: number;
  sampleCount: number;
}

export async function getEffortEma(
  tableName: string,
  userId: number,
  activity: string,
): Promise<EffortEma | null> {
  const result = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `EFFORT#${userId}` },
        sk: { S: activity },
      },
      ProjectionExpression: "ema, sampleCount",
    }),
  );

  if (!result.Item) return null;

  return {
    ema: Number(result.Item.ema.N),
    sampleCount: Number(result.Item.sampleCount.N),
  };
}

export async function updateEffortEma(
  tableName: string,
  userId: number,
  activity: string,
  effort: string,   // "low" | "medium" | "high"
  alpha: number,     // from EMA_ALPHA env var, default 0.3
): Promise<void> {
  const currentValue = EFFORT_VALUES[effort];
  if (currentValue === undefined) return;

  const now = new Date().toISOString();
  const pk = `EFFORT#${userId}`;
  const sk = activity;

  // Read current state
  const current = await getEffortEma(tableName, userId, activity);

  if (!current) {
    // Cold start: first observation
    try {
      await client.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { pk: { S: pk }, sk: { S: sk } },
          UpdateExpression:
            "SET ema = :ema, sampleCount = :one, lastEffort = :effort, updatedAt = :now",
          ConditionExpression: "attribute_not_exists(pk)",
          ExpressionAttributeValues: {
            ":ema": { N: String(currentValue) },
            ":one": { N: "1" },
            ":effort": { S: effort },
            ":now": { S: now },
          },
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        // Race: another invocation created it first. Retry as update.
        return updateEffortEma(tableName, userId, activity, effort, alpha);
      }
      throw error;
    }
    return;
  }

  // Compute new EMA
  const newEma = roundEma(
    alpha * currentValue + (1 - alpha) * current.ema,
  );

  // Conditional write with optimistic locking
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: pk }, sk: { S: sk } },
        UpdateExpression:
          "SET ema = :newEma, sampleCount = :newCount, lastEffort = :effort, updatedAt = :now",
        ConditionExpression: "sampleCount = :expectedCount",
        ExpressionAttributeValues: {
          ":newEma": { N: String(newEma) },
          ":newCount": { N: String(current.sampleCount + 1) },
          ":expectedCount": { N: String(current.sampleCount) },
          ":effort": { S: effort },
          ":now": { S: now },
        },
      }),
    );
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      console.warn("Effort EMA update conflict, skipping");
      return;
    }
    throw error;
  }
}
```

#### When to Update EMA

**Immediately after each event, not batched.** Reasons:
1. The worker Lambda already processes messages one at a time (batch size 1, configured in `/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts` line 63)
2. The EMA computation is O(1) -- a single read and a single write
3. Batching would require a separate mechanism (scheduled Lambda, DynamoDB Streams) that adds complexity with zero benefit at this throughput
4. Immediate updates mean the EMA is always current when the next classification uses it as prompt context

The update should happen in the worker pipeline at `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts` **after** saving the activity event (Step 3, line 77) and **before** response policy evaluation (Step 4, line 93), so the updated EMA is available for future classifications but does not block the current response:

```
Step 1: Classify (OpenAI)
Step 2: Skip if "none"
Step 3: Save activity
Step 3.5: Update effort EMA  <-- NEW
Step 4: Evaluate response policy
Step 5: Send response
```

#### Handling the 10-Data-Point Threshold

The PRD requires "at least 10 data points before adjusting behavior" (PRD line 122). This applies to **preference adaptation** (suppressing responses, reducing clarifications), not to EMA computation. The EMA should be updated from the first observation. The threshold check belongs in the **response policy** evaluation at `/Users/martinnordlund/homeOps/src/shared/services/response-policy.ts`:

```typescript
function shouldSuppressForUser(
  ignoreRate: { ema: number; sampleCount: number } | null,
): boolean {
  if (!ignoreRate) return false;
  if (ignoreRate.sampleCount < 10) return false; // Not enough data
  return ignoreRate.ema > 0.7;
}

function shouldReduceClarifications(
  frequency: { ema: number; sampleCount: number } | null,
): boolean {
  if (!frequency) return false;
  if (frequency.sampleCount < 10) return false; // Not enough data
  return frequency.ema < 1.0; // Less than 1 message per day
}
```

This keeps the EMA service clean (pure math) and the policy service responsible for thresholds.

---

## Recommendation

### Summary Table

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| Alpha for effort | 0.3 (PRD default) | Adapts in ~9 observations, stable against outliers |
| Alpha for ignore rate | 0.2 (PRD default) | Conservative; ~13 observations to forget initial, prevents premature suppression |
| Cold start | First observation = initial EMA | Simple, correct, guarded by 10-point threshold |
| Minimum sample count | No separate minimum for EMA; 10-point threshold in response policy only | Keeps EMA service clean, policy owns business logic |
| Effort encoding | low=1, medium=2, high=3 (PRD) | Simple, readable, sufficient for 3-level ordinal scale |
| Numeric precision | Round to 4 decimal places | Prevents floating-point noise, sufficient precision |
| DynamoDB update | Read-then-conditional-write with sampleCount as optimistic lock | Correct under concurrency; multiplication not supported in UpdateExpression |
| Conflict handling | Log warning and skip | Self-correcting at next observation; near-zero probability at household scale |
| Update timing | Immediately after each activity event | O(1) compute, keeps EMA current, no batching infrastructure needed |
| Binary metrics (ignore rate) | EMA with 0/1 input | Mathematically equivalent to exponentially weighted proportion; bounded [0,1] |
| Interaction frequency | EMA on daily message count (alpha=0.2) | Simpler than 7-day rolling window; approximate equivalence |
| Active hours | Derive from existing PATTERN records' hourOfDayCounts | Avoids duplicating hour tracking in two places |

### New Service Files

Following existing codebase patterns, Phase 3 should add:

- `/src/shared/services/effort-tracker.ts` -- getEffortEma, updateEffortEma
- `/src/shared/services/preference-tracker.ts` -- getIgnoreRate, updateIgnoreRate, getInteractionFrequency, updateInteractionFrequency

Both use the `homeops` shared table (PK/SK pattern) and the low-level `@aws-sdk/client-dynamodb` client, consistent with existing services.

### CDK Changes

The `homeops` shared table already exists in `/Users/martinnordlund/homeOps/infra/constructs/message-store.ts` (line 24-37) with `pk`/`sk` keys and a `gsi1` GSI. No new tables or GSIs are needed for EMA storage. The Worker Lambda needs `dynamodb:GetItem` and `dynamodb:UpdateItem` permissions on the `homeops` table, which should be added in `/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts`.

### Environment Variables

Add `EMA_ALPHA` to the Worker Lambda environment (default: `0.3`). The ignore rate alpha (0.2) can either be a second env var (`EMA_ALPHA_IGNORE`) or hardcoded, since the PRD only specifies configurability for the effort alpha.

## Trade-offs

| Decision | What You Give Up |
|----------|-----------------|
| Read-then-conditional-write (not atomic) | Extra DynamoDB read per EMA update (~5ms latency, negligible cost). Could use simple SET without locking at this scale with near-zero risk. |
| Rounding to 4 decimal places | Theoretical precision loss. In practice, irrelevant for a 3-value input scale. |
| First observation as initial EMA | Biased early values if first observation is atypical. Mitigated by 10-point threshold. |
| EMA for interaction frequency (not rolling window) | Not exactly a "7-day average" as PRD states. Approximates it with alpha=0.2 (effective window ~5 days). Could use exact rolling window with per-day counters if precision matters. |
| Deriving active hours from PATTERN records | Loses "recency weighting" -- all historical hours count equally. Could add decay to PATTERN counters if recency matters. |
| Swallowing optimistic locking conflicts | A rare lost EMA update. Self-corrects on next observation. |
| Alpha values from PRD (not tunable per user) | All users in a household get the same smoothing. Could store per-user alpha, but vastly over-engineered for 2-5 users. |

## Open Questions

1. **Ignore rate trigger mechanism.** The PRD defines "ignored" as "no reply or reaction within 30 minutes." How is this measured? The recommended approach (check on next message) is simple but imprecise. If precision matters, an EventBridge scheduled rule per bot response would be needed -- but that adds significant infrastructure for a preference metric. Decision needed from the planning phase.

2. **Interaction frequency: what counts as "day close"?** If a user sends messages on Monday and Wednesday but not Tuesday, should Tuesday count as 0 messages? With the "update on first message of new day" approach, Tuesday is skipped entirely. This biases the EMA upward (only counts active days). The PRD threshold of "< 1 msg/day" may need to account for this.

3. **Should the Worker Lambda timeout be increased further?** Phase 2 already increased it from 30s to 60s for OpenAI latency. Phase 3 adds 2-3 DynamoDB reads/writes (EMA + preferences). These are fast (~5-10ms each) and should not require a timeout increase, but worth monitoring.

4. **EMA_ALPHA configurability scope.** The PRD says alpha is configurable via `EMA_ALPHA` env var. Should there be separate env vars for effort alpha and ignore rate alpha? Or a single alpha for all EMA metrics? The recommendation is separate vars (`EMA_ALPHA` for effort, `EMA_ALPHA_IGNORE` for ignore rate) since the PRD specifies different values (0.3 and 0.2).

5. **Active hours: separate metric or derived?** This document recommends deriving from PATTERN records to avoid duplication. But the PRD lists `activeTimes` as a separate preference metric with its own record (PK `PREF#<userId>`, SK `activeTimes`). The planning phase should decide whether to follow the PRD exactly (separate record) or simplify (derive from PATTERN). If separate, a decaying counter map is the recommended approach.
