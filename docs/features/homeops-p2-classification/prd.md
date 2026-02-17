# PRD: Message Understanding & Activity Logging

**Feature ID:** homeops-p2-classification
**Project:** HomeOps
**Phase:** 2 of 6
**Roadmap:** `/docs/projects/homeops/roadmap.md`
**Status:** Phase 0 — Scoping

## Goal

Classify natural Swedish messages as `chore | recovery | none` via OpenAI and log structured activity events. The agent stays silent by default and only responds when confident, directly addressed, or when clarification is needed — respecting strict output limits.

## Background

Phase 1 deployed the infrastructure: Telegram webhook → API Gateway → Ingest Lambda → SQS → Worker Lambda → DynamoDB (raw messages). The Worker Lambda currently stores raw messages and does nothing else. Phase 2 adds intelligence: the Worker calls OpenAI to understand each message, stores classified activities, and occasionally responds through Telegram.

## Architecture

```
SQS (from Phase 1)
       │
       ▼
 Worker Lambda
       │
       ├──► OpenAI Chat Completions API
       │         │
       │         ▼
       │    Classification result
       │    { type, activity, effort, confidence }
       │
       ├──► DynamoDB: activities table (if chore/recovery)
       │
       ├──► DynamoDB: response_counters table (rate limit check)
       │
       └──► Telegram Bot API (if response policy allows)
```

## In Scope

### 1. OpenAI Integration

- Call OpenAI chat completions API from Worker Lambda
- System prompt in English instructs the model to classify Swedish household messages
- Structured JSON output: `{ type, activity, effort, confidence }`
- OpenAI API key read from Secrets Manager (already provisioned in Phase 1)
- Timeout and error handling — failed classifications must not block the pipeline
- Few-shot examples in the system prompt for common Swedish household phrases

### 2. Classification System

- Every message classified as `chore | recovery | none`
- Confidence score (0.0–1.0) returned with each classification
- Activity name extracted in Swedish (e.g., "tvätt", "disk", "städning")
- Effort estimate: `low | medium | high` (simple heuristic from OpenAI, refined by Phase 3 EMA)
- Messages classified as `none` → no further action, no response

### 3. Activity Event Logging

- New DynamoDB `activities` table for structured activity events
- Each classified activity (chore or recovery) stored with:
  - `chatId` (partition key)
  - `activityId` (sort key — ULID for time-ordered uniqueness)
  - `messageId` (link back to raw message)
  - `userId`
  - `userName`
  - `type` (`chore | recovery`)
  - `activity` (Swedish activity name)
  - `effort` (`low | medium | high`)
  - `confidence` (0.0–1.0)
  - `timestamp` (Unix ms, from original message)
  - `createdAt` (ISO 8601)
- GSI: `userId-timestamp-index` (PK: `userId`, SK: `timestamp`) for "who did what" queries

### 4. Group Response Policy

Agent may respond in group chat only when:
- Classification confidence >= 0.85 (acknowledgment)
- Directly addressed (message mentions bot name or replies to bot)
- Uncertain but promising classification (clarification question)

Output limits (hard-enforced):
| Property  | Limit         |
|-----------|---------------|
| Length    | <= 1 line     |
| Tone     | neutral       |
| Emoji    | <= 1          |
| Frequency | <= 3/day/chat |

### 5. Silence Rules

Agent must remain silent when:
- Classification is `none`
- Confidence < 0.85 (unless clarification threshold met)
- Conversation is fast-moving (>3 messages in last 60 seconds from other users)
- Topic is irrelevant to household activities
- Agent responded recently (within last 15 minutes in the same chat)
- Outside quiet hours: 22:00–07:00 Europe/Stockholm
- Daily response cap (3) already reached for this chat

### 6. Clarification Policy

When classification is uncertain but promising (confidence 0.50–0.84):
- Agent may ask a clarification question
- Maximum 5 words in Swedish
- Format: `"Menade du [activity]?"`
- Counts toward the daily response cap
- Only one clarification per message — never chain clarifications

### 7. Tone Enforcement (Basic)

All agent output must pass tone validation before sending:
- No blame ("du borde...")
- No comparison ("X gjorde mer än Y")
- No commands ("gör detta")
- No judgment ("bra jobbat", "dåligt")
- Fallback: if tone check fails, suppress the message entirely (silence > bad output)

### 8. Telegram Response

- Send replies via Telegram Bot API `sendMessage` endpoint
- Bot token read from Secrets Manager (already provisioned)
- Reply in the same chat where the message originated
- Use `reply_to_message_id` to thread responses to the triggering message
- Handle API errors gracefully — failed sends logged but do not cause retries

### 9. Response Rate Tracking

- Track daily response count per chat in DynamoDB
- Simple counter with date key, reset at midnight Europe/Stockholm
- Check counter before sending any response
- Increment counter after successful send
- Eventual consistency acceptable — slightly exceeding 3 is tolerable, systematic over-responding is not

### 10. Fast Conversation Detection

- Before responding, check recent message timestamps in the same chat
- If 3+ messages from other users arrived in the last 60 seconds → suppress response
- Uses message timestamps from the raw messages table (Phase 1)
- Simple query: last N messages for chatId, check timestamp spread

## Out of Scope

- Alias learning / vocabulary mapping (→ Phase 3)
- Effort learning / EMA refinement (→ Phase 3)
- Preference learning / ignore rate tracking (→ Phase 3)
- DM channel routing (→ Phase 3)
- Balance calculation (→ Phase 4)
- Fairness engine (→ Phase 4)
- Dispute detection and intelligence (→ Phase 4)
- Recovery intelligence / behavior modification (→ Phase 4)
- Promise detection (→ Phase 5)
- Planner engine / EventBridge scheduling (→ Phase 5)
- Proactive behavior (→ Phase 5)
- DM insights (→ Phase 6)
- Clarification follow-up tracking (learning from clarification responses → Phase 3)
- Multi-language support (Swedish only for user messages)

## Success Criteria

- [ ] Worker Lambda calls OpenAI to classify every incoming Swedish message
- [ ] Messages classified as `chore`, `recovery`, or `none` with confidence score
- [ ] Classified activities (chore/recovery) stored in DynamoDB `activities` table with full schema
- [ ] Agent stays silent for messages classified as `none`
- [ ] Agent stays silent when confidence < 0.85 (unless clarification range)
- [ ] Agent stays silent outside quiet hours (22:00–07:00 Stockholm)
- [ ] Agent stays silent when daily response cap (3/chat) reached
- [ ] Agent stays silent during fast-moving conversations (>3 msgs/60s)
- [ ] Clarification questions sent when confidence is 0.50–0.84 (max 5 words)
- [ ] All output respects limits: <= 1 line, neutral tone, <= 1 emoji
- [ ] No responses contain blame, comparison, commands, or judgment
- [ ] Telegram Bot API used to send responses back to group chat
- [ ] Response counter tracks and enforces daily limit per chat
- [ ] OpenAI API errors handled gracefully without blocking the pipeline
- [ ] Failed Telegram sends logged but do not cause message processing retries

## Constraints

- **OpenAI API** (not Anthropic) per PRD spec
- **System prompt in English**, user messages in Swedish
- **Precision over recall** — missing an activity is better than interrupting incorrectly
- **Response frequency hard-capped** at <= 3/day per group chat
- **Quiet hours**: 22:00–07:00 Europe/Stockholm
- **Counter reset**: midnight Europe/Stockholm
- **Existing infrastructure**: Must extend Phase 1 CDK stack, not replace it
- **Worker Lambda**: Classification added to existing worker, not a new Lambda
- **Secrets Manager**: OpenAI key and Telegram bot token already provisioned

## DynamoDB Table Design

### `activities` table (new)

| Attribute    | Type   | Key  |
|-------------|--------|------|
| chatId      | String | PK   |
| activityId  | String | SK (ULID) |
| messageId   | Number |      |
| userId      | Number |      |
| userName    | String |      |
| type        | String | (`chore` \| `recovery`) |
| activity    | String | (Swedish name) |
| effort      | String | (`low` \| `medium` \| `high`) |
| confidence  | Number | (0.0–1.0) |
| timestamp   | Number | (Unix ms) |
| createdAt   | String | (ISO 8601) |

**GSI:** `userId-timestamp-index` — PK: `userId`, SK: `timestamp`

### `response_counters` table (new)

| Attribute  | Type   | Key  |
|-----------|--------|------|
| chatId    | String | PK   |
| date      | String | SK (YYYY-MM-DD, Stockholm time) |
| count     | Number |      |
| updatedAt | String | (ISO 8601) |

TTL on items older than 7 days to auto-cleanup.

## Suggested Research Areas

1. **OpenAI prompt engineering** — Structured JSON output for Swedish household activity classification, confidence scoring calibration, few-shot examples, and token cost optimization
2. **Telegram Bot API responses** — `sendMessage` with `reply_to_message_id`, rate limits, bot permissions in group chats, error codes and retry semantics
3. **DynamoDB schema validation** — Verify `activities` and `response_counters` table designs against query patterns (who did what last, daily count check, time-range queries)
4. **Rate limiting in Lambda** — Atomic counter increment patterns in DynamoDB, handling concurrent workers, Stockholm timezone handling in Lambda (date boundaries)
