# DynamoDB Table Design Research

**Feature:** homeops-p1-infra
**Research Question:** Single-table vs multi-table DynamoDB design for the full HomeOps data model (Phases 1-6)
**Date:** 2026-02-17

## Summary

HomeOps requires storing 6 distinct entity types (messages, events, users/aliases, balances, promises, summaries) across 6 project phases. After analyzing access patterns, entity relationships, data volumes, cost implications, and migration complexity, the recommended approach is a **hybrid design**: a dedicated `messages` table for high-volume raw message storage (Phase 1) and a shared `homeops` table using single-table design for all other entities (Phases 2-6). This balances simplicity for Phase 1 delivery with a forward-looking structure that avoids premature complexity while preserving DynamoDB best practices.

## 1. Entity Inventory and Access Patterns

### Entity Catalog

| Entity | Phase | Volume Estimate (monthly) | Avg Item Size | Key Relationships |
|--------|-------|--------------------------|---------------|-------------------|
| Raw Messages | 1 | ~3,000-10,000 items | ~1-2 KB | Standalone, referenced by events |
| Activity Events | 2 | ~500-2,000 items | ~0.5 KB | Derived from messages, linked to users |
| User Aliases | 3 | ~20-50 items (mostly static) | ~0.2 KB | Linked to users |
| User Preferences | 3 | ~5-10 items (mostly static) | ~0.3 KB | Per-user settings |
| Balance Records | 4 | ~100-500 items | ~0.3 KB | Between two users |
| Promises | 5 | ~50-200 items | ~0.4 KB | Per user, time-based lifecycle |
| Summaries | 6 | ~10-50 items | ~1 KB | Aggregations, per-user or per-household |

### Access Patterns

| # | Access Pattern | Entity | Query Shape | Frequency |
|---|---------------|--------|-------------|-----------|
| A1 | Get all messages for a chat (time range) | Messages | PK=chatId, SK between timestamps | High |
| A2 | Get messages by user in a chat | Messages | PK=chatId, filter on userId (or GSI) | Medium |
| A3 | Get recent events/activities | Events | PK=chatId, SK descending by time | Medium |
| A4 | Get events by user | Events | GSI: PK=userId, SK=timestamp | Medium |
| A5 | Look up user by Telegram ID | Users | PK=telegramId | Low |
| A6 | Look up user by alias | Users/Aliases | GSI or inverted index: PK=alias | Low |
| A7 | Get balance between two users | Balances | PK=userPair, SK=period | Low |
| A8 | Get active promises for a user | Promises | PK=userId, filter status=active | Low |
| A9 | Get overdue promises | Promises | GSI: PK=status, SK=deadline | Low (scheduled) |
| A10 | Get weekly summary for user | Summaries | PK=userId, SK=week | Low |

### Key Observations

1. **Messages are high-volume, simple access.** The dominant pattern is "all messages in chat X, sorted by time." This is a textbook DynamoDB partition+sort key query.
2. **Events, aliases, preferences, promises, balances** are all low-volume entities that are frequently queried alongside each other (e.g., "get user's events + active promises + current balance" for planner engine decisions).
3. **Cross-entity queries are common in later phases.** The planner engine (Phase 5, section 15 of PRD) needs activity history, promises, patterns, and load balance as inputs -- these are separate entities that benefit from co-location.
4. **Messages are rarely queried with other entities.** The worker writes messages; the classifier reads them. After classification, the event record is the primary data unit.

## 2. Design Approaches

### Option A: Single-Table Design (All Entities in One Table)

All entities share one DynamoDB table with overloaded composite keys.

**Key Structure:**

```
PK                      SK                          Entity
CHAT#123                MSG#1708000000#456          Raw Message
CHAT#123                EVENT#1708000000#e1         Activity Event
USER#telegram_42        PROFILE                     User Profile
USER#telegram_42        PREF                        Preferences
USER#telegram_42        PROMISE#p1                  Promise
USER#telegram_42        EVENT#1708000000#e1         User's Event (copy)
ALIAS#tvatten           USER#telegram_42            Alias Mapping
BALANCE#user1#user2     PERIOD#2026-W07             Balance Record
SUMMARY#telegram_42     WEEK#2026-W07               Weekly Summary
```

**GSIs Required:**

| GSI | PK | SK | Purpose |
|-----|----|----|---------|
| GSI1 | `GSI1PK` (userId) | `GSI1SK` (timestamp) | Events by user, promises by user |
| GSI2 | `GSI2PK` (status) | `GSI2SK` (deadline) | Overdue promises, active items |
| GSI3 | `GSI3PK` (alias) | `GSI3SK` (userId) | Alias lookups |

**Pros:**
- Single table to manage in CDK, IAM policies, backups
- Co-located data enables efficient `Query` for related entities
- Follows AWS's general recommendation: "most applications require only one table"
- Fewer IAM policies and CloudWatch dashboards

**Cons:**
- Complex key design from Day 1, even though Phase 1 only needs messages
- GSIs project all entity types, creating storage waste
- Harder to reason about -- developers must understand the full key schema to write any query
- Hot partition risk: a busy chat's messages share partition space with its events, aliases, etc.
- Harder to set different TTLs or backup policies per entity type
- Over-engineering for a project that currently has zero deployed infrastructure

### Option B: Multi-Table Design (One Table Per Entity)

Separate tables: `messages`, `events`, `users`, `aliases`, `balances`, `promises`, `summaries`.

**Pros:**
- Each table has clear, simple key design
- Independent capacity management per table
- Independent backup/restore, TTL, and retention policies
- Easy to understand and debug -- each table is self-documenting
- Phase 1 can ship with just the `messages` table

**Cons:**
- 7 tables to manage in CDK, IAM, monitoring
- Cross-entity queries require multiple DynamoDB calls (planner engine needs events + promises + balance)
- More IAM policies to maintain
- Each table has its own 100-byte-per-item overhead for table metadata
- On-demand tables each have independent burst capacity, which is wasteful at low volumes

### Option C: Hybrid Design (Recommended)

Two tables:
1. **`messages` table** -- dedicated to raw messages (high volume, simple access, Phase 1)
2. **`homeops` table** -- single-table design for all other entities (events, users, aliases, preferences, balances, promises, summaries)

**Rationale:** Messages are fundamentally different from the other entities:
- They are high-volume append-only data
- They have the simplest access pattern (chat + time range)
- They are never queried alongside other entities in the same request
- They may need different TTL/retention policies (raw message data vs. derived intelligence)
- They are the only entity in Phase 1

All other entities are low-volume, frequently queried together, and benefit from co-location.

## 3. Hybrid Design: Detailed Schema

### Table 1: `homeops-messages`

**Purpose:** Raw Telegram message storage (Phase 1 delivery).

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `chatId` | String | PK | Telegram chat ID (prefixed: `CHAT#-123456`) |
| `messageId` | Number | SK | Telegram message ID (monotonically increasing per chat) |
| `userId` | Number | -- | Telegram user ID |
| `userName` | String | -- | Telegram username or display name |
| `text` | String | -- | Message text content |
| `timestamp` | Number | -- | Unix timestamp in seconds |
| `raw` | String | -- | Full Telegram update JSON |
| `createdAt` | String | -- | ISO 8601 timestamp of when the record was created |

**Note on Sort Key choice:** The PRD specifies `messageId` (Number) as SK. Telegram message IDs are monotonically increasing integers within a chat, so they serve as a natural chronological sort key. This is better than using a timestamp SK because:
- Message IDs are guaranteed unique within a chat (natural deduplication)
- They preserve Telegram's ordering
- No risk of timestamp collisions

**GSI for user-based queries (add in Phase 2 when needed):**

| GSI | PK | SK | Projected | Purpose |
|-----|----|----|-----------|---------|
| `userId-timestamp-index` | `userId` (Number) | `timestamp` (Number) | `KEYS_ONLY` + `text`, `chatId` | Messages by user across chats |

**Phase 1 needs zero GSIs.** The primary access pattern (all messages in a chat) is served by the base table. The user-message GSI can be added in Phase 2 when the classifier needs to analyze per-user message history.

### Table 2: `homeops` (Single-Table Design)

**Purpose:** All non-message entities, starting Phase 2.

**Base table key design:**

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `PK` | String | PK | Partition key (entity-prefixed) |
| `SK` | String | SK | Sort key (entity-prefixed) |
| `GSI1PK` | String | -- | GSI1 partition key |
| `GSI1SK` | String | -- | GSI1 sort key |
| `type` | String | -- | Entity type discriminator (`EVENT`, `USER`, `ALIAS`, etc.) |

**Entity key patterns:**

```
Entity: Activity Event
  PK:     CHAT#-123456
  SK:     EVENT#2026-02-17T10:30:00Z#evt_abc123
  GSI1PK: USER#42
  GSI1SK: EVENT#2026-02-17T10:30:00Z
  Attrs:  type=EVENT, category=chore|recovery|none, description, confidence,
          sourceMessageId, effort, userId, userName

Entity: User Profile
  PK:     USER#42
  SK:     PROFILE
  GSI1PK: (not set)
  GSI1SK: (not set)
  Attrs:  type=USER, telegramId, displayName, householdId, createdAt

Entity: Alias Mapping
  PK:     ALIAS#tvatten
  SK:     ALIAS
  GSI1PK: USER#42
  GSI1SK: ALIAS#tvatten
  Attrs:  type=ALIAS, alias, canonicalActivity, learnedFrom, confidence,
          createdAt, updatedAt

Entity: User Preferences
  PK:     USER#42
  SK:     PREF
  GSI1PK: (not set)
  GSI1SK: (not set)
  Attrs:  type=PREF, ignoreRate, responseTimingPref, interactionFrequency,
          updatedAt

Entity: Balance Record
  PK:     HOUSEHOLD#h1
  SK:     BALANCE#USER#42#USER#99#2026-W07
  GSI1PK: USER#42
  GSI1SK: BALANCE#2026-W07
  Attrs:  type=BALANCE, user1Id, user2Id, period, netLoad1, netLoad2,
          delta, updatedAt

Entity: Promise
  PK:     USER#42
  SK:     PROMISE#2026-02-17T10:30:00Z#prm_abc123
  GSI1PK: PROMISE_STATUS#active
  GSI1SK: PROMISE_DEADLINE#2026-02-18T00:00:00Z
  Attrs:  type=PROMISE, description, deadline, status (active|fulfilled|expired),
          sourceMessageId, chatId, createdAt, updatedAt

Entity: Weekly Summary
  PK:     USER#42
  SK:     SUMMARY#2026-W07
  GSI1PK: (not set)
  GSI1SK: (not set)
  Attrs:  type=SUMMARY, period, choresCount, recoveryCount, netLoad,
          fairnessScore, highlights, createdAt
```

**GSI Design:**

| GSI | PK | SK | Projection | Access Patterns Served |
|-----|----|----|------------|----------------------|
| `GSI1` | `GSI1PK` | `GSI1SK` | `ALL` | Events by user (A4), aliases by user, balances by user, overdue promises (A9 -- query `PROMISE_STATUS#active` with deadline range) |

**Why only one GSI?** By carefully designing `GSI1PK` and `GSI1SK`, a single GSI can serve multiple access patterns:

- **Events by user:** `GSI1PK = USER#42, GSI1SK begins_with EVENT#`
- **Active promises (overdue check):** `GSI1PK = PROMISE_STATUS#active, GSI1SK < PROMISE_DEADLINE#<now>`
- **Aliases for a user:** `GSI1PK = USER#42, GSI1SK begins_with ALIAS#`
- **Balances for a user:** `GSI1PK = USER#42, GSI1SK begins_with BALANCE#`

**Alias lookup (A6)** is served by the base table directly: `PK = ALIAS#tvatten`.

## 4. GSI Cost Analysis

### GSI Storage and Write Overhead

Each GSI is essentially a copy of projected attributes:
- **Storage:** Each GSI item adds ~100 bytes of overhead plus the projected attribute sizes
- **Write amplification:** Every write to the base table that includes GSI key attributes triggers a write to the GSI. If a GSI key attribute changes, this costs 2 GSI writes (delete old + write new)

### Cost Implications Per Approach

| Approach | GSIs Needed | Write Amplification | Storage Overhead |
|----------|-------------|--------------------|-|
| Single-table (Option A) | 2-3 GSIs | 2-3x writes for entities with GSI keys | ~100-300 bytes/item x 3 GSIs |
| Multi-table (Option B) | 1-2 GSIs across 3-4 tables | 1-2x per table, but only tables that need it | Minimal -- only where needed |
| Hybrid (Option C) | 0 GSIs on messages table, 1 GSI on homeops table | 1x on messages (no GSI), ~2x on homeops GSI items | ~100 bytes/item on homeops GSI |

**Hybrid wins on GSI cost** because:
1. The high-volume messages table has zero GSIs (the user-message GSI can be deferred)
2. The homeops table is low-volume, so GSI write amplification is negligible
3. One well-designed GSI covers all cross-entity access patterns

### Projected GSI Costs (Household Scale)

For a 2-5 person household generating ~5,000 messages/month and ~1,000 derived events:

- **Messages table GSI writes (if added):** ~5,000 items x $1.4175/million = ~$0.007/month
- **Homeops table GSI writes:** ~1,500 items x $1.4175/million = ~$0.002/month
- **GSI storage:** <1 MB total = effectively free (within 25 GB free tier)

**Conclusion: GSI costs are negligible at household scale.** The design decision should be driven by access pattern correctness, not GSI cost optimization.

## 5. Cost Analysis

### On-Demand vs Provisioned

| Factor | On-Demand | Provisioned (Free Tier) |
|--------|-----------|------------------------|
| Write cost | ~$1.4175/million WRU (eu-north-1 est.) | 25 WCU free = ~2.16M writes/month free |
| Read cost | ~$0.2835/million RRU (eu-north-1 est.) | 25 RCU free = ~6.48M reads/month free |
| Storage | $0.27/GB/month (first 25 GB free) | $0.27/GB/month (first 25 GB free) |
| Scaling | Automatic, instant | Must provision; auto-scaling adds delay |
| Minimum cost | $0 when idle | $0 (free tier covers baseline) |
| Burst handling | Handles any spike | May throttle on unexpected spikes |

### Monthly Cost Estimate (Household of 3, Moderate Usage)

**Assumptions:**
- ~5,000 messages/month (~170/day, reasonable for an active family chat)
- ~1,000 derived events/month
- ~200 other writes (aliases, preferences, balances, promises)
- ~10,000 reads/month (classifier reads, user lookups, planner queries)
- ~50 MB total storage after 1 year

**On-Demand Cost:**

| Component | Calculation | Monthly Cost |
|-----------|------------|--------------|
| Writes | 6,200 WRU x $1.4175/1M | $0.009 |
| Reads | 10,000 RRU x $0.2835/1M | $0.003 |
| Storage | 50 MB (within 25 GB free tier) | $0.00 |
| **Total** | | **~$0.01/month** |

**Provisioned (Free Tier) Cost:**

| Component | Calculation | Monthly Cost |
|-----------|------------|--------------|
| Writes | 6,200/month = ~0.002 WCU avg (well within 25 WCU free) | $0.00 |
| Reads | 10,000/month = ~0.004 RCU avg (well within 25 RCU free) | $0.00 |
| Storage | 50 MB (within 25 GB free tier) | $0.00 |
| **Total** | | **$0.00/month** |

### Recommendation: Provisioned with Free Tier

At household scale, the workload fits entirely within DynamoDB's Always Free tier (25 WCU, 25 RCU, 25 GB). Using provisioned mode with low capacity settings (e.g., 5 WCU / 5 RCU) keeps costs at exactly $0/month while still handling the expected load.

**However**, on-demand is the safer choice for Phase 1 because:
1. It eliminates throttling risk during development and testing (burst traffic from debugging)
2. The cost difference is effectively zero at this scale (~$0.01/month)
3. It requires no capacity planning
4. You can switch from on-demand to provisioned at any time (once per 24 hours)

**Recommended approach:** Start with on-demand for Phase 1 development. Switch to provisioned (free tier) once traffic patterns are confirmed stable, if cost optimization is desired. The savings are negligible, so on-demand is fine indefinitely.

## 6. Migration Path

### Starting Simple, Evolving Later

The hybrid approach is specifically designed for incremental delivery:

| Phase | Table Changes | Migration Required? |
|-------|--------------|-------------------|
| Phase 1 | Create `homeops-messages` table only | No -- greenfield |
| Phase 2 | Create `homeops` table, add events | No -- new table, no data migration |
| Phase 2+ | Optionally add `userId-timestamp-index` GSI to messages | No migration -- GSI backfills automatically |
| Phase 3 | Add user/alias/preference items to `homeops` table | No -- just new item types in existing table |
| Phase 4 | Add balance items to `homeops` table | No -- just new item types |
| Phase 5 | Add promise items + GSI1 to `homeops` table | GSI backfill only -- no data migration |
| Phase 6 | Add summary items to `homeops` table | No -- just new item types |

**Key insight: Single-table design in DynamoDB is inherently schema-less.** Adding new entity types to the `homeops` table requires zero migration -- you just start writing items with new PK/SK patterns. GSIs can be added at any time and DynamoDB automatically backfills them.

### What Would Require Migration?

These changes would require data migration (read + re-write items):

1. **Changing the PK/SK structure of existing items** -- e.g., renaming `CHAT#` prefix to `GROUP#`
2. **Splitting a table into multiple tables** -- e.g., moving events out of `homeops` into their own table
3. **Merging tables** -- e.g., combining messages into the homeops table
4. **Changing GSI key attributes** -- requires creating a new GSI and deleting the old one

None of these are expected with the hybrid approach, because the design accounts for all 6 phases upfront.

### Migration Difficulty Comparison

| Starting Approach | Migrating To | Difficulty | Risk |
|-------------------|-------------|------------|------|
| Messages-only table (Phase 1) | Hybrid (add homeops table) | **Trivial** -- just create a new table | None |
| Single-table (all entities) | Splitting out messages table | **Moderate** -- must migrate message items | Downtime or dual-write period |
| Multi-table | Merging into single-table | **Hard** -- must migrate all items, redesign keys | High complexity |
| Hybrid | Full single-table | **Moderate** -- migrate messages into shared table | Possible but rarely needed |

## 7. Comparison Summary

| Criterion | Single-Table (A) | Multi-Table (B) | Hybrid (C) |
|-----------|-----------------|-----------------|------------|
| Phase 1 simplicity | Poor -- must design full schema upfront | Good -- just one simple table | **Best** -- one simple table, defer complexity |
| Cross-entity queries | **Best** -- single query | Poor -- multiple calls | Good -- single query for related entities, separate for messages |
| Operational overhead | **Best** -- 1 table | Poor -- 7 tables | Good -- 2 tables |
| Per-entity flexibility | Poor -- shared settings | **Best** -- independent | Good -- messages independent, others share |
| GSI efficiency | Moderate -- GSIs span all items | Good -- targeted GSIs | **Best** -- no GSI on high-volume table |
| Developer experience | Poor -- complex key design | **Best** -- simple, obvious | Good -- simple Phase 1, manageable Phase 2+ |
| Migration risk | High -- locked into design | Low -- independent tables | **Low** -- natural evolution path |
| DynamoDB best practices | Yes (AWS recommendation) | Acceptable for simple apps | **Yes** -- aligned with AWS guidance |
| Cost (household scale) | ~$0/month | ~$0/month | ~$0/month |

## Recommendations

### Primary Recommendation: Hybrid Design (Option C)

Use two tables:
1. **`homeops-messages`** for raw Telegram messages (Phase 1, deployed immediately)
2. **`homeops`** for all other entities using single-table design (Phase 2+, deployed when needed)

### Rationale

1. **Phase 1 ships fast.** The messages table has the simplest possible design (`chatId` PK, `messageId` SK, no GSIs) and matches the PRD specification exactly. No need to design the full entity schema before delivering Phase 1.

2. **Messages are fundamentally different.** They are high-volume, append-only, time-ordered, and never queried with other entities. Separating them avoids hot partition issues and allows independent TTL/retention policies.

3. **Single-table design applies where it matters.** The remaining entities (events, users, aliases, balances, promises, summaries) are low-volume, frequently queried together (especially by the planner engine), and benefit from co-location. One well-designed GSI serves all cross-entity access patterns.

4. **Zero-migration evolution path.** Phase 1 creates one table. Phase 2 creates another. Subsequent phases add new item types to the second table without any data migration. GSIs are added when the access patterns that need them are implemented.

5. **Cost is irrelevant at this scale.** All approaches cost effectively $0/month for a household. The design decision should optimize for developer velocity and correctness.

### Phase 1 Concrete Deliverable

```typescript
// CDK definition for Phase 1
const messagesTable = new dynamodb.Table(this, 'MessagesTable', {
  tableName: 'homeops-messages',
  partitionKey: { name: 'chatId', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'messageId', type: dynamodb.AttributeType.NUMBER },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // on-demand
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  removalPolicy: cdk.RemovalPolicy.RETAIN, // protect data on cdk destroy
  pointInTimeRecovery: true,
});
```

### Capacity Mode Recommendation

Start with **on-demand (PAY_PER_REQUEST)** for both tables. At household scale (~6,000 writes/month, ~10,000 reads/month), the cost is ~$0.01/month. Switching to provisioned free tier is possible later but unnecessary.

### Naming Convention

- Table names: `homeops-messages`, `homeops` (short, clear, prefixed for AWS console filtering)
- PK/SK prefixes: `CHAT#`, `USER#`, `ALIAS#`, `EVENT#`, `PROMISE#`, `BALANCE#`, `SUMMARY#` (entity-type prefix with `#` delimiter)
- GSI attribute names: `GSI1PK`, `GSI1SK` (generic, reusable across entity types)
- Timestamps in sort keys: ISO 8601 format for lexicographic sorting (`2026-02-17T10:30:00Z`)

## Trade-offs

### What We Give Up with the Hybrid Approach

1. **Not fully single-table.** Messages live in their own table, so a theoretical "get messages + events for a chat in one query" is not possible. In practice, this query is never needed -- the classifier reads messages, produces events, and downstream consumers read events.

2. **Two tables instead of one.** Slightly more CDK code, two IAM policies instead of one, two CloudWatch dashboards. The overhead is minimal.

3. **Deferred schema design for the homeops table.** The full single-table key design for Phase 2+ entities is sketched here but not finalized until Phase 2 implementation. This is a feature, not a bug -- it avoids premature optimization.

4. **Not fully multi-table.** Entities in the shared `homeops` table cannot have fully independent capacity, TTL, or backup policies. At household scale, this is irrelevant.

## Open Questions

1. **Should `chatId` include a prefix?** The PRD shows `chatId` as a plain string (the Telegram chat ID). Adding a `CHAT#` prefix is consistent with single-table design conventions but adds complexity to Phase 1. Recommendation: use the raw Telegram chat ID as-is for the messages table (it is the only entity type in that table, so prefixing adds no value). Use prefixed keys in the homeops table.

2. **TTL on messages?** Should raw messages expire after a certain period (e.g., 90 days)? The PRD mentions "minimal retention" in security requirements (section 24). Once messages are classified into events (Phase 2), the raw message data may no longer be needed. This should be decided as part of Phase 2 implementation. DynamoDB TTL can be enabled at any time without migration.

3. **Point-in-time recovery vs on-demand backups?** PITR costs $0.00023/GB/month in eu-north-1 (estimate). At <1 GB of data, this is effectively free. Recommend enabling PITR on both tables for simplicity.

4. **Should the `homeops` table be created in Phase 1 or Phase 2?** Creating it in Phase 1 is cheap (empty table costs nothing) and proves the CDK code works. But it adds unused infrastructure. Recommendation: defer to Phase 2 -- keep Phase 1 focused on the messages pipeline.

5. **DynamoDB Streams?** Phase 2 may benefit from DynamoDB Streams on the messages table to trigger classification when new messages arrive. This would replace or complement the SQS-based worker. This is a Phase 2 architecture decision and does not affect the table design.
