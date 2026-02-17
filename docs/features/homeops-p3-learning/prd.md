# PRD: Memory System & Learning

**Feature ID:** homeops-p3-learning
**Project:** HomeOps
**Phase:** 3 of 6
**Roadmap:** `/docs/projects/homeops/roadmap.md`
**Status:** Phase 0 — Scoping

## Goal

Enable persistent learning across aliases, effort patterns, and user preferences so the agent improves over time. After Phase 3, the agent recognizes household-specific vocabulary, tracks how much effort each person typically spends on activities, adjusts its own behavior based on user engagement, and can route personal interactions to DM.

## Background

Phase 2 deployed the classification pipeline: messages arrive via SQS, the Worker Lambda calls OpenAI (`gpt-4o-mini`) to classify Swedish household messages as `chore | recovery | none`, stores structured activity events in the `activities` table, and optionally responds via Telegram. The clarification system asks "Menade du [activity]?" when confidence is 0.50–0.84 but currently discards the user's response — it cannot learn from corrections. Effort is estimated per-message by OpenAI with no historical context.

Phase 3 closes these gaps: capture clarification responses to learn vocabulary, accumulate effort history for smarter estimates, track user engagement to tune behavior, and open a DM channel for personal interactions.

## Architecture

```
SQS (from Phase 1)
       |
       v
 Worker Lambda
       |
       +---> Alias Resolver (pre-process text with learned vocabulary)
       |           |
       |           v
       +---> OpenAI Classification (enriched with alias + effort context)
       |           |
       |           v
       +---> Activity Store (save event)
       |           |
       |           v
       +---> Effort Tracker (update EMA for user + activity)
       |           |
       |           v
       +---> Preference Tracker (update engagement metrics)
       |           |
       |           v
       +---> Response Policy (existing, now preference-aware)
       |           |
       |           v
       +---> Channel Router (group vs DM decision)
       |           |
       |           v
       +---> Telegram Sender (group or DM)

 Clarification Response Flow:
 User replies to bot's clarification message
       |
       v
 Worker detects reply-to-bot with clarification context
       |
       +---> Alias Store (save confirmed mapping)
       +---> Re-classify original message with confirmed activity
```

## In Scope

### 1. Alias Learning

Learn household-specific vocabulary so the agent improves classification accuracy over time.

**Seed Vocabulary:**
- Ship a predefined set of common Swedish household aliases (e.g., "pant" → "pantning", "dammsuga" → "dammsuging", "disk" → "diskning", informal/slang → canonical forms)
- Seed aliases are per-system (not per-chat) and act as defaults
- Learned aliases are per-chat — different households may use different vocabulary

**Learning from Clarifications:**
- When a user replies to the bot's clarification question (detected via `replyToIsBot` + `replyToMessageId`), check if the original bot message was a clarification ("Menade du...?")
- If the user confirms (e.g., "ja", "yes", "mm", "precis"), save the alias mapping: original word/phrase → confirmed activity
- If the user corrects (e.g., "nej, jag menade tvätt"), extract the correction and save that mapping instead
- Store alias with confidence metadata (number of times confirmed)

**Using Aliases at Classification Time:**
- Before sending text to OpenAI, resolve known aliases in the message text
- Append resolved aliases as context in the classification prompt (e.g., "Note: user's household uses 'pant' to mean 'pantning'")
- Do not replace text — provide context so OpenAI makes the final call

**Alias Override Rules:**
- Explicit user corrections always win over learned aliases
- Higher-confirmation aliases take precedence when ambiguous
- Seed aliases can be overridden by per-chat learned aliases

### 2. Effort Learning (EMA)

Track perceived effort per user + activity type using Exponential Moving Average, replacing the single-message OpenAI estimate with a historically-informed score.

**EMA Calculation:**
- Formula: `EMA_new = α × current_effort + (1 - α) × EMA_previous`
- Effort values: `low = 1`, `medium = 2`, `high = 3`
- Default smoothing factor: `α = 0.3` (configurable via environment variable `EMA_ALPHA`)
- Cold start: First observation becomes the initial EMA (no smoothing applied)

**Storage:**
- Store in the generic `homeops` table: PK `EFFORT#<userId>`, SK `<canonicalActivity>`
- Fields: `ema` (number), `sampleCount` (number), `lastUpdated` (ISO 8601)

**Integration with Classification:**
- After saving an activity event, update the EMA for that user + activity
- Include user's historical effort context in the OpenAI prompt when classifying (e.g., "This user's typical effort for 'diskning' is medium (EMA: 2.1)")
- OpenAI still makes the final effort call — EMA provides context, not override

### 3. Preference Learning

Track per-user engagement metrics and gradually adjust agent behavior to match each person's preferences.

**Tracked Metrics:**
- **Ignore rate**: Fraction of bot responses that receive no reply or reaction within 30 minutes. Stored as EMA (same formula as effort, α = 0.2)
- **Response timing**: Average time-of-day the user is active (hour buckets, rolling 7-day window)
- **Interaction frequency**: Messages per day from this user (rolling 7-day average)

**Storage:**
- Generic `homeops` table: PK `PREF#<userId>`, SK `<metricName>`
- Fields vary by metric (e.g., `ignoreRate`, `activeHours[]`, `avgMessagesPerDay`)

**Behavioral Adaptation:**
- High ignore rate (> 0.7): Suppress optional responses (acknowledgments) for this user — only respond to clarifications and direct mentions
- Low interaction frequency (< 1 msg/day): Avoid clarification questions — user prefers minimal interaction
- Adaptation is gradual — requires at least 10 data points before adjusting behavior
- Changes surfaced via DM (Phase 3 DM channel) with subtle hints, never in group chat

**Adaptation Transparency (Subtle Hints in DM):**
- When behavior adapts, note it in DM if user has opted in (e.g., in a future weekly summary: "Jag har anpassat mig och svarar lite mindre i gruppen")
- Never announce changes in group chat
- Never make it feel like surveillance — frame as "I'm learning your preferences"

### 4. Memory System (Full)

Complete all four memory types. Events already exist from Phase 2. Add three new types.

**Memory Type 1 — Event Logs (existing):**
- Already stored in `activities` table
- No changes needed, but add query support (see §6)

**Memory Type 2 — Language Aliases (new):**
- Stored in `homeops` table: PK `ALIAS#<chatId>`, SK `<normalizedAlias>`
- Fields: `canonicalActivity` (string), `confirmations` (number), `source` ("seed" | "learned"), `learnedFrom` (userId, optional), `createdAt`, `updatedAt`
- GSI1: `gsi1pk = ALIASES_BY_ACTIVITY#<chatId>`, `gsi1sk = <canonicalActivity>` — for reverse lookups

**Memory Type 3 — Behavior Preferences (new):**
- Stored in `homeops` table: PK `PREF#<userId>`, SK `<metricName>`
- Fields: metric-specific values + `updatedAt`
- Queryable per-user: get all preferences for a userId

**Memory Type 4 — Pattern Habits (new):**
- Stored in `homeops` table: PK `PATTERN#<chatId>#<userId>`, SK `<canonicalActivity>`
- Fields: `dayOfWeekCounts` (map: Mon-Sun → count), `hourOfDayCounts` (map: 0-23 → count), `lastSeen` (ISO 8601), `totalCount` (number)
- Updated after each activity event — increment day-of-week and hour-of-day counters
- Enables queries like "Martin usually does dishes on Mondays"

### 5. Channel Routing (Group vs DM)

Differentiate group chat from DM and route personal interactions appropriately.

**DM Onboarding:**
- Users have not yet started private chats with the bot
- When the bot first needs to DM a user (e.g., preference adaptation hint), it cannot — Telegram requires users to initiate
- Solution: One-time group message (per user) suggesting they start a private chat: "Skriv /start till mig privat om du vill ha personliga uppdateringar"
- Track DM opt-in status per user in `homeops` table: PK `DM#<userId>`, SK `STATUS`
- Once a user /start's the bot in DM, capture the private chat ID and mark them as opted-in

**Routing Rules:**
- Group chat behavior: unchanged from Phase 2 (passive observer, acknowledges high-confidence, clarifies medium-confidence)
- DM-appropriate content: preference adaptation hints, personal effort summaries (Phase 6), ratings collection (Phase 6)
- If user hasn't opted in to DM: skip DM-only content silently — do not nag in group chat
- DM responses do NOT count toward the daily group response cap

**Detecting /start in DM:**
- The Ingest Lambda already processes all incoming messages
- Add logic: if `chat.type === "private"` and text is `/start`, store the private chatId for that userId
- Messages from private chats are processed but skip group-specific rules (quiet hours still apply, daily cap does not)

### 6. Memory Queries

Support lookups against event history for "who did X last?" style questions.

**Supported Query Types:**
- "Who did [activity] last?" — query `activities` table by activity name, get most recent
- "When did [user] last do [activity]?" — query `userId-timestamp-index` GSI, filter by activity
- "How many times did [user] do [activity] this week?" — query GSI with timestamp range

**Trigger:**
- When bot is directly addressed with a question-like message containing query keywords
- Classification returns `type: "none"` but `directlyAddressed: true` — route to query handler
- Query handler parses intent and executes the appropriate DynamoDB query

**Response Format:**
- Short, factual Swedish response (e.g., "Martin diskade senast igår kl 18:30")
- Counts toward daily response cap
- Subject to tone validation (no blame/comparison)

## Out of Scope

- Balance algorithm and NetLoad calculation (-> Phase 4)
- Fairness engine with weighted metrics (-> Phase 4)
- Recovery intelligence and behavior modification (-> Phase 4)
- Dispute detection (-> Phase 4)
- Full tone enforcement beyond current rules (-> Phase 4)
- Promise detection from natural language (-> Phase 5)
- Planner engine and EventBridge scheduling (-> Phase 5)
- Proactive behavior and proactivity budget (-> Phase 5)
- DM weekly insight generation (-> Phase 6)
- DM rating collection UI (-> Phase 6)
- DM personal summaries (-> Phase 6)
- Multi-language support (Swedish only for user messages)

## Success Criteria

- [ ] Seed alias vocabulary loaded and used during classification
- [ ] Alias mappings stored in DynamoDB (`homeops` table) per chat
- [ ] New aliases learned from clarification confirmations (user confirms → alias saved)
- [ ] User corrections override previously learned aliases
- [ ] Learned aliases improve classification accuracy (aliases included as OpenAI prompt context)
- [ ] EMA effort scores calculated per user + activity type after each event
- [ ] EMA uses configurable smoothing factor (default α = 0.3)
- [ ] Cold start handled correctly (first observation = initial EMA)
- [ ] Preference metrics tracked: ignore rate (EMA), response timing (hourly), interaction frequency (daily)
- [ ] Agent suppresses optional responses for users with high ignore rate (> 0.7, after 10+ data points)
- [ ] Agent reduces clarification questions for low-frequency users (< 1 msg/day, after 10+ data points)
- [ ] Pattern habits updated after each activity (day-of-week and hour-of-day counters)
- [ ] All four memory types (events, language, behavior, patterns) persisted and queryable
- [ ] "Who did X last?" queries return correct results from event history
- [ ] Private chat /start detection captures DM opt-in per user
- [ ] Group vs DM messages routed correctly — group remains passive, DM allows personal content
- [ ] DM responses do not count toward group daily response cap
- [ ] Preference adaptation hints delivered via DM (not group chat) for opted-in users
- [ ] All memory records are timestamped and auditable

## Constraints

- **DynamoDB as datastore** — use the existing generic `homeops` table (pk/sk) for new record types
- **EMA smoothing factor** configurable via environment variable (`EMA_ALPHA`, default 0.3)
- **Alias learning must not override explicit corrections** — user corrections always win
- **Preference adaptation must be gradual** — minimum 10 data points before adjusting behavior
- **No behavioral changes announced in group chat** — only subtle hints in DM
- **Telegram DM requires user opt-in** — bot cannot initiate private chats; users must /start first
- **Existing infrastructure** — extend Phase 1/2 CDK stack, do not replace
- **Worker Lambda** — all learning logic added to existing worker pipeline
- **OpenAI model** — continue using `gpt-4o-mini` for classification

## DynamoDB Record Design

All new records use the existing generic `homeops` table (PK: `pk`, SK: `sk`, GSI: `gsi1pk`/`gsi1sk`).

### Alias Records

| Field | Value |
|-------|-------|
| pk | `ALIAS#<chatId>` |
| sk | `<normalizedAlias>` (lowercase, trimmed) |
| canonicalActivity | string (e.g., "pantning") |
| confirmations | number |
| source | `"seed"` or `"learned"` |
| learnedFrom | userId (number, optional) |
| gsi1pk | `ALIASES_BY_ACTIVITY#<chatId>` |
| gsi1sk | `<canonicalActivity>` |
| createdAt | ISO 8601 |
| updatedAt | ISO 8601 |

### Effort EMA Records

| Field | Value |
|-------|-------|
| pk | `EFFORT#<userId>` |
| sk | `<canonicalActivity>` |
| ema | number (1.0–3.0) |
| sampleCount | number |
| lastEffort | `"low"` / `"medium"` / `"high"` |
| updatedAt | ISO 8601 |

### Preference Records

| Field | Value |
|-------|-------|
| pk | `PREF#<userId>` |
| sk | `ignoreRate` / `activeTimes` / `interactionFrequency` |
| value | number or map (metric-dependent) |
| sampleCount | number |
| updatedAt | ISO 8601 |

### Pattern Habit Records

| Field | Value |
|-------|-------|
| pk | `PATTERN#<chatId>#<userId>` |
| sk | `<canonicalActivity>` |
| dayOfWeekCounts | map: `{ "mon": 5, "tue": 2, ... }` |
| hourOfDayCounts | map: `{ "0": 1, "8": 4, ... }` |
| totalCount | number |
| lastSeen | ISO 8601 |
| updatedAt | ISO 8601 |

### DM Status Records

| Field | Value |
|-------|-------|
| pk | `DM#<userId>` |
| sk | `STATUS` |
| optedIn | boolean |
| privateChatId | number (Telegram chat ID) |
| optedInAt | ISO 8601 |
| updatedAt | ISO 8601 |

## Suggested Research Areas

1. **EMA implementation** — Smoothing factor selection, cold-start handling, numeric stability for edge cases (very few observations), effort value encoding (`low=1, medium=2, high=3` vs alternatives)
2. **DynamoDB query patterns** — Efficient alias lookup at classification time (batch get vs query), pattern habit aggregation queries, GSI usage for reverse alias lookups
3. **Clarification response detection** — Reliable detection of affirmative vs corrective replies in Swedish ("ja", "mm", "precis" vs "nej, jag menade..."), edge cases (delayed replies, non-text replies)
4. **Telegram DM lifecycle** — Bot API for detecting /start in private chats, storing private chat IDs, permissions model, rate limits for DM messages
