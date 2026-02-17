# Research: Telegram Bot API — Private Chat Lifecycle & Channel Routing

**Research question:** How does the Telegram Bot API handle private chat (DM) lifecycle, including /start command detection, DM sending, block/unblock behavior, and what changes are needed in the HomeOps ingest/worker pipeline to support group-vs-DM routing?

**Feature:** homeops-p3-learning (Phase 3)
**Date:** 2026-02-17

---

## Summary

Telegram bots cannot initiate private conversations -- users must send `/start` first. In private chats, `chat.id` equals `from.id` (the user's ID), so storing the private `chatId` is equivalent to storing the userId. The current HomeOps webhook registers with `allowed_updates: ["message"]`, which already delivers `/start` commands from private chats. The Ingest Lambda needs a small addition to include `chat.type` in the SQS message body, and the Worker Lambda needs a channel router that checks DM opt-in status before deciding where to send responses. No new infrastructure (tables, queues, Lambdas) is required -- all DM status records fit in the existing `homeops` single table.

---

## Findings

### 1. The /start Command in Private Chats

#### Webhook Payload

When a user opens a private chat with the bot and taps "Start" (or types `/start`), the webhook receives a standard `message` update. The payload looks like this:

```json
{
  "update_id": 527095032,
  "message": {
    "message_id": 1,
    "from": {
      "id": 111222333,
      "is_bot": false,
      "first_name": "Martin",
      "username": "martinnordlund",
      "language_code": "sv"
    },
    "chat": {
      "id": 111222333,
      "first_name": "Martin",
      "username": "martinnordlund",
      "type": "private"
    },
    "date": 1708185600,
    "text": "/start",
    "entities": [
      {
        "type": "bot_command",
        "offset": 0,
        "length": 6
      }
    ]
  }
}
```

Key observations:
- `chat.id` equals `from.id` (both are `111222333`). This is always true for private chats.
- `chat.type` is `"private"` (vs `"group"` or `"supergroup"` for group chats).
- The `/start` text appears in the `text` field, and `entities` contains a `bot_command` entity.
- The `from` object includes `language_code`, which could be useful for future i18n but is not needed now.

#### Deep Linking: /start with Payload

When a user clicks a deep link like `t.me/homeops_bot?start=onboard`, Telegram opens the private chat and sends:

```json
{
  "message": {
    "text": "/start onboard",
    "entities": [
      { "type": "bot_command", "offset": 0, "length": 6 }
    ],
    "chat": { "id": 111222333, "type": "private" },
    "from": { "id": 111222333 }
  }
}
```

The payload parameter (`onboard`) is appended to the text after a space. The `bot_command` entity only covers `/start` (length 6), not the payload. Payload constraints: `[A-Za-z0-9_-]`, max 512 characters.

For the PRD's onboarding prompt ("Skriv /start till mig privat"), the deep link format `t.me/homeops_bot?start=onboard` is cleaner -- the user taps a link instead of manually finding the bot.

#### /start in Group Chat vs Private Chat

In a **group** chat, `/start` is only processed if appended with the bot's username: `/start@homeops_bot`. In groups, the `chat.type` is `"group"` or `"supergroup"`, and `chat.id` is a negative number (e.g., `-4001234567890`).

Detection logic to distinguish:
```typescript
const isPrivateChat = message.chat.type === "private";
const isStartCommand = message.text === "/start" || message.text?.startsWith("/start ");
```

#### Is /start Required Before the Bot Can Send DMs?

**Yes, absolutely.** Telegram bots cannot initiate conversations with users. A user must send at least one message to the bot privately (typically `/start`) before the bot can send DMs to that user. This is an anti-spam restriction enforced by Telegram itself.

If the bot tries to send a message to a user who has never started a private chat:
- Error: `400 Bad Request: chat not found`

#### Block/Unblock Behavior

| User Action | Bot Receives | Bot Can Send DM? |
|---|---|---|
| User sends /start | `message` update with `/start` text | Yes |
| User blocks bot | `my_chat_member` update (status: `"kicked"`) | No (403 error) |
| User unblocks bot | `my_chat_member` update (status: `"member"`) | **No** -- user must send a message again |
| User sends /start after unblock | `message` update with `/start` | Yes again |

Critical detail: **Unblocking alone is not sufficient.** The user must actively send a message (e.g., `/start`) after unblocking before the bot can send DMs again. Simply unblocking restores the ability to receive messages from the bot in theory, but in practice the bot's attempts to send will fail until the user re-initiates contact.

### 2. Private Chat ID Storage

#### chat.id === from.id

In Telegram private chats, `chat.id` is always identical to `from.id` (the user's Telegram user ID). This means:
- **No separate "private chat ID" needs to be stored.** The userId itself is the privateChatId.
- However, the PRD defines a `DM#<userId>` record with a `privateChatId` field. This is slightly redundant but harmless -- it makes the data model self-documenting and guards against any future Telegram behavior change (unlikely but defensive).

#### Fields to Store from the /start Update

For the `DM#<userId>` record in the `homeops` table:

```
pk:           "DM#111222333"
sk:           "STATUS"
optedIn:      true
privateChatId: 111222333         // Same as userId, but stored explicitly
userName:     "martinnordlund"   // For display purposes
firstName:    "Martin"           // From from.first_name
optedInAt:    "2026-02-17T10:00:00Z"
updatedAt:    "2026-02-17T10:00:00Z"
```

#### What the Ingest Lambda Needs to Change

The current Ingest Lambda (`/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts`) constructs a `messageBody` object for SQS but does **not** include `chat.type`. This field is essential for Phase 3 routing. The change is minimal:

```typescript
// Current (line 39-46 of ingest/index.ts):
const messageBody: Record<string, unknown> = {
  chatId: message.chat.id,
  messageId: message.message_id,
  userId: from.id,
  userName: from.username ?? from.first_name,
  text: message.text,
  timestamp: message.date,
};

// Needed addition:
const messageBody: Record<string, unknown> = {
  chatId: message.chat.id,
  chatType: message.chat.type,   // NEW: "private" | "group" | "supergroup"
  messageId: message.message_id,
  userId: from.id,
  userName: from.username ?? from.first_name,
  text: message.text,
  timestamp: message.date,
};
```

The `MessageBody` type in `/Users/martinnordlund/homeOps/src/shared/types/classification.ts` also needs a `chatType` field:

```typescript
export interface MessageBody {
  chatId: string;
  chatType?: "private" | "group" | "supergroup";  // NEW
  messageId: number;
  userId: number;
  userName: string;
  text: string;
  timestamp: number;
  replyToMessageId?: number;
  replyToIsBot?: boolean;
}
```

### 3. Sending DMs

#### API Method

Sending a DM uses the same `sendMessage` endpoint as group messages. The only difference is the `chat_id` value: a positive user ID instead of a negative group ID.

```typescript
// Send to group (existing)
await sendMessage({ token, chatId: -4001234567890, text: "Noterat", replyToMessageId: 42 });

// Send to private chat (new)
await sendMessage({ token, chatId: 111222333, text: "Personligt meddelande", replyToMessageId: 0 });
```

For DMs, `replyToMessageId` is often irrelevant (the bot is sending proactively, not replying). The existing `telegram-sender.ts` uses `reply_parameters` unconditionally. For DMs, either:
- Pass `replyToMessageId: 0` with `allow_sending_without_reply: true` (safe -- Telegram ignores invalid message_id), or
- Make `replyToMessageId` optional in the `SendMessageParams` interface and omit `reply_parameters` when not provided. **This is the cleaner approach.**

#### Suggested Sender Modification

The current `sendMessage` in `/Users/martinnordlund/homeOps/src/shared/services/telegram-sender.ts` requires `replyToMessageId`. For DMs, make it optional:

```typescript
interface SendMessageParams {
  token: string;
  chatId: number;
  text: string;
  replyToMessageId?: number;  // Make optional for DMs
}

export async function sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const { token, chatId, text, replyToMessageId } = params;
  const body: Record<string, unknown> = { chat_id: chatId, text };

  if (replyToMessageId !== undefined) {
    body.reply_parameters = {
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
    };
  }

  // ... rest unchanged
}
```

#### Error Handling for DMs

| Scenario | Error Code | Description | Action |
|---|---|---|---|
| User never started private chat | 400 | `Bad Request: chat not found` | Mark user as not opted in. Do not retry. |
| User blocked the bot | 403 | `Forbidden: bot was blocked by the user` | Set `optedIn: false` in DM status record. Do not retry. |
| User deactivated their account | 403 | `Forbidden: user is deactivated` | Set `optedIn: false`. Do not retry. |
| Rate limited | 429 | `Too Many Requests: retry after N` | Log warning. Do not retry (DM content is optional). |

When a 403 error is received for a DM attempt, the system should update the `DM#<userId>` record:

```typescript
// On 403 from DM send attempt:
await updateDmStatus(userId, { optedIn: false, updatedAt: new Date().toISOString() });
```

This prevents repeated failed DM attempts. The user's opt-in status is automatically restored when they send `/start` again.

#### Rate Limits for DMs

| Scope | Limit |
|---|---|
| Per private chat | ~1 message/second |
| Per group | 20 messages/minute |
| Global (broadcast) | ~30 messages/second across all chats |

HomeOps DM volume is negligible: at most 1-2 DMs per user per day (preference hints). Rate limits are not a concern.

### 4. Webhook Payload Differences: Group vs Private

#### Side-by-Side Comparison

**Group message:**
```json
{
  "message": {
    "chat": {
      "id": -4001234567890,
      "title": "Nordlund Household",
      "type": "supergroup"
    },
    "from": { "id": 111222333 },
    "text": "Jag diskade"
  }
}
```

**Private message:**
```json
{
  "message": {
    "chat": {
      "id": 111222333,
      "first_name": "Martin",
      "username": "martinnordlund",
      "type": "private"
    },
    "from": { "id": 111222333 },
    "text": "/start"
  }
}
```

Key differences:
- `chat.type`: `"private"` vs `"group"` / `"supergroup"`
- `chat.id`: positive (same as user ID) vs negative
- `chat.title`: absent in private, present in groups
- `chat.first_name` / `chat.username`: present in private, absent in groups

#### Can the Same Webhook Handle Both?

**Yes.** The same webhook endpoint and Ingest Lambda can handle both group and private messages. The current `allowed_updates: ["message"]` already delivers both. No changes to the webhook registration are needed for basic `/start` detection.

However, if the system also wants to detect when a user **blocks** the bot (to proactively mark `optedIn: false`), the webhook needs `my_chat_member` updates added to `allowed_updates`. See Section 8 for the recommendation.

### 5. Group-to-DM Prompt UX (Onboarding)

#### PRD Requirement

The PRD (Section 5, line 161) says:
> "One-time group message (per user) suggesting they start a private chat: 'Skriv /start till mig privat om du vill ha personliga uppdateringar'"

#### Deep Link Approach

Instead of telling users to manually find the bot, use a clickable deep link:

```
Skriv /start till mig privat om du vill ha personliga uppdateringar: t.me/homeops_bot?start=onboard
```

Or even simpler, with the bot username as a clickable mention:

```
Vill du ha personliga uppdateringar? Skriv /start till @homeops_bot privat!
```

The deep link `t.me/homeops_bot?start=onboard` is preferred because:
1. One tap opens the private chat with the bot
2. The "Start" button is prominently shown
3. The `onboard` payload can be used to track the source of the opt-in (from the group prompt vs organic)

Note: The bot username must be known at runtime. It is already cached via `getBotInfo()` in `telegram-sender.ts`.

#### Tracking Prompted Users

To avoid nagging (sending the onboarding prompt repeatedly), track which users have been prompted:

**Option A: Separate "prompted" field in `DM#<userId>` record**
```
pk: "DM#111222333"
sk: "STATUS"
optedIn: false
prompted: true         // Set when onboarding prompt is sent
promptedAt: "2026-02-17T10:00:00Z"
```

**Option B: Use a TTL-based "prompt cooldown"**
Store a `DM#<userId>#PROMPTED` record with a TTL of, say, 90 days. If the record exists, do not prompt again. This is self-cleaning.

**Recommendation:** Option A is simpler and the data is co-located with the DM status. A single `prompted` boolean on the DM status record is sufficient. The prompt is one-time per user.

#### When to Send the Prompt

The PRD says the prompt is sent "when the bot first needs to DM a user." In Phase 3, DM-eligible content is limited to preference adaptation hints (e.g., "Jag har anpassat mig och svarar lite mindre i gruppen"). The prompt should be sent:
- After the preference system has adapted (ignore rate > 0.7 or low frequency, with 10+ data points)
- Only if `DM#<userId>` record does not exist or has `optedIn: false` and `prompted: false`
- As a group message reply to the user's message (so they see it)

### 6. Channel Routing Logic

#### Decision Matrix

| Content Type | Group? | DM? | Both? | Notes |
|---|---|---|---|---|
| Activity acknowledgment ("Noterat") | Yes | No | No | Unchanged from Phase 2 |
| Clarification question ("Menade du...?") | Yes | No | No | Must be in context of the group conversation |
| Preference adaptation hint | No | Yes | No | "Jag har anpassat mig..." -- personal, not group-appropriate |
| Onboarding prompt | Yes | No | No | One-time group message suggesting DM opt-in |
| Query response ("Martin diskade senast igår") | Yes | No | No | Response to group question stays in group |

**The bot should never respond in both group AND DM for the same message.** Each message has exactly one response channel. The channel router is a pure function of (content type, DM opt-in status):

```typescript
type ResponseChannel = "group" | "dm" | "none";

function routeResponse(
  contentType: "acknowledge" | "clarify" | "preference_hint" | "onboarding_prompt" | "query_response",
  isDmOptedIn: boolean,
): ResponseChannel {
  switch (contentType) {
    case "preference_hint":
      return isDmOptedIn ? "dm" : "none";  // Skip silently if not opted in
    case "onboarding_prompt":
      return "group";  // Always in group
    case "acknowledge":
    case "clarify":
    case "query_response":
      return "group";  // Always in group
  }
}
```

#### Edge Case: User Sends Message in Both Group and DM

This is not really an edge case -- messages in different chats are independent updates processed separately. A message in the group chat gets classified normally (chore/recovery/none). A message in the private chat is a DM interaction (e.g., `/start`, or a future personal command). They do not interfere with each other.

#### Processing Private Chat Messages in the Worker

When the Worker receives a message with `chatType === "private"`:
1. **If text is `/start` (or `/start <payload>`):** Store DM opt-in status. Optionally reply with a welcome message in the private chat: "Tack! Du kan nu ta emot personliga uppdateringar." Do NOT classify the message.
2. **If text is something else in private chat:** For Phase 3, ignore. In future phases, private chat messages could trigger personal commands. Log and skip classification.

### 7. Rate Limits & DM Response Cap Independence

#### DM Responses vs Group Response Cap

The PRD (line 169) is explicit:
> "DM responses do NOT count toward the daily group response cap"

The current response counter (`/Users/martinnordlund/homeOps/src/shared/services/response-counter.ts`) keys on `chatId + date`. Since the group chatId (negative) and the private chatId (positive/userId) are different, they naturally have separate counters. **No code change is needed for cap isolation** -- the existing counter design already separates by chatId.

However, DMs should have their own rate limiting to prevent accidentally spamming users:
- **DM daily cap:** 5 messages per user per day (generous for Phase 3 where DM content is minimal)
- Implemented using the same `response-counter` service with the private chatId as the key

#### Telegram Rate Limits

Already covered in Section 3. For private chats, the limit is ~1 msg/sec per chat. HomeOps sends at most a few DMs per day per user. Not a concern.

### 8. Webhook Configuration: `my_chat_member` Updates

#### Current State

The webhook is registered with `allowed_updates: ["message"]` via `/Users/martinnordlund/homeOps/scripts/register-webhook.sh` (line 114). This means the webhook receives:
- All `message` updates (both group and private chats)

It does NOT receive:
- `my_chat_member` updates (block/unblock events)
- `edited_message` updates
- `callback_query` updates

#### Should We Add `my_chat_member`?

**Probably not for Phase 3.** Here is the trade-off:

| Approach | Pros | Cons |
|---|---|---|
| Add `my_chat_member` to `allowed_updates` | Detect blocks proactively, update DM status immediately | More Lambda invocations (though rare), Ingest Lambda must handle a new update type (not a `message`), more complex parsing |
| Keep `allowed_updates: ["message"]` only | Simpler, no new update types to handle | Block detection is reactive (403 on next DM attempt), minor delay in marking user as blocked |

The reactive approach (detect 403 when trying to send a DM) is simpler and sufficient for Phase 3 volume. The bot sends DMs so rarely (preference hints only) that a few seconds/hours delay in detecting a block is irrelevant.

**Recommendation:** Keep `allowed_updates: ["message"]` for Phase 3. Add `my_chat_member` in a future phase if proactive block detection becomes important (e.g., Phase 6 weekly summaries where you want to know ahead of time if a user is unreachable).

### 9. Impact on Current Ingest Lambda

The current Ingest Lambda (`/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts`) uses `isTextMessage(update)` as a gate. This check passes for `/start` in private chats (it is a text message), so the Ingest Lambda will already accept and forward `/start` messages to SQS. No filtering changes needed.

However, the Ingest Lambda currently does not include `chat.type` in the SQS message body. This is the only change needed in the Ingest Lambda for Phase 3 DM support.

The `TelegramChat` type in `/Users/martinnordlund/homeOps/src/shared/types/telegram.ts` already has `type: string`, so no type changes are needed there. The `MessageBody` type needs a `chatType` field added.

---

## Recommendation

### Implementation Approach for DM Opt-In

1. **Ingest Lambda:** Add `chatType: message.chat.type` to the SQS message body. This is a one-line addition.

2. **MessageBody type:** Add `chatType?: "private" | "group" | "supergroup"` to the `MessageBody` interface. Make it optional for backward compatibility with in-flight SQS messages during deployment.

3. **Worker Lambda:** Add early routing logic before classification:
   ```
   if chatType === "private" and text starts with "/start":
     → Store DM opt-in (DM#<userId> in homeops table)
     → Optionally send welcome message in private chat
     → Skip classification, continue to next SQS record
   if chatType === "private" and text is anything else:
     → Log and skip (no classification for private messages in Phase 3)
     → Continue to next SQS record
   ```

4. **DM Status Service:** New service (`dm-status.ts` or similar) with:
   - `getDmStatus(userId)` -- Query `homeops` table for `DM#<userId>` / `STATUS`
   - `setDmOptedIn(userId, privateChatId)` -- Upsert the record with `optedIn: true`
   - `setDmOptedOut(userId)` -- Update to `optedIn: false` (called on 403 errors)
   - `markPrompted(userId)` -- Set `prompted: true` on the record

5. **Channel Router:** A pure function deciding `"group" | "dm" | "none"` based on content type and DM status. Sits between the response policy and the Telegram sender in the worker pipeline.

6. **Telegram Sender:** Make `replyToMessageId` optional in `SendMessageParams`. When omitted, do not include `reply_parameters` in the API call. This allows proactive DM sends without a reply context.

7. **Webhook registration:** No changes needed. `allowed_updates: ["message"]` already covers `/start` in private chats.

8. **CDK changes:** Grant the Worker Lambda read/write access to the `homeops` table (for DM status records). This table already exists in `MessageStore` but may not be wired to the Worker Lambda yet.

### DM Status Record in DynamoDB

Use the PRD-defined schema in the existing `homeops` table:

```
pk:           "DM#<userId>"
sk:           "STATUS"
optedIn:      true/false
privateChatId: <userId>          // Same value, stored explicitly
userName:     "<username>"
prompted:     true/false         // Has the onboarding prompt been sent?
promptedAt:   "<ISO 8601>"       // When was the prompt sent?
optedInAt:    "<ISO 8601>"       // When did the user /start?
updatedAt:    "<ISO 8601>"
```

### Error Handling Strategy for Failed DM Sends

1. Attempt to send DM via `sendMessage` with the private `chatId`.
2. If `ok: true`: DM delivered. Increment DM-specific response counter (using private chatId).
3. If 403 (`bot was blocked by the user`): Update DM status to `optedIn: false`. Log. Do not retry.
4. If 400 (`chat not found`): User never started chat. Update DM status to `optedIn: false`. Log. Do not retry.
5. If 429 (rate limited): Log warning. Do not retry. DM content is optional.
6. Any other error: Log. Do not retry. DMs are never critical.

### Testing Strategy

1. **Unit tests for channel router:** Pure function, easy to test all combinations of (content type, DM status).
2. **Unit tests for DM status service:** Mock DynamoDB, test get/set/markPrompted.
3. **Unit tests for /start detection in Worker:** Mock a private chat message with `/start` text, verify DM status is stored and classification is skipped.
4. **Integration test:** Use the existing webhook test harness to send a private chat message and verify it flows through the pipeline correctly. The `chat.type === "private"` detection is the critical integration point.
5. **Manual testing:** In Telegram, open a private chat with the bot, send `/start`, verify the DM status record in DynamoDB, then have the bot send a DM.

---

## Trade-offs

| Decision | What We Gain | What We Give Up |
|---|---|---|
| Keep `allowed_updates: ["message"]` (no `my_chat_member`) | Simpler Ingest Lambda, no new update types to parse | Block detection is reactive (403 on send), not proactive |
| Store `privateChatId` even though it equals `userId` | Self-documenting data model, defensive against future Telegram changes | Slightly redundant data (~8 bytes per record) |
| Make `replyToMessageId` optional in sender | Clean DM sends without fake reply context | Minor API surface change, existing callers unaffected |
| DM daily cap separate from group cap | Users are not penalized for DM interactions, group acknowledgments not starved by DMs | Two cap counters to manage (but they use the same service, just different chatIds) |
| Skip classification for private chat messages | Clean separation -- private chat is for bot commands, not chore logging | Users cannot log chores via DM (PRD does not require this) |
| Reactive 403 detection instead of `my_chat_member` webhook | Less Lambda invocations, simpler code | Slightly delayed awareness of user blocking (only discovered on next DM attempt) |
| One-time `prompted` boolean instead of TTL-based cooldown | Simpler, no TTL management, user is only prompted once ever | If user declines, they are never prompted again (manual re-prompt would require DB update) |

---

## Open Questions

1. **Welcome message text.** When a user sends `/start` in private chat, should the bot respond with a welcome message? The PRD does not specify the text. Suggested: "Tack! Du kan nu ta emot personliga uppdateringar fran mig." This is a UX decision, not a technical one.

2. **DM content in Phase 3.** The PRD says preference adaptation hints are sent via DM (Section 3, line 123-128). But the actual content generation for these hints ("Jag har anpassat mig och svarar lite mindre i gruppen") is not detailed. Is this a templated string, or should OpenAI generate it? For Phase 3, a simple template seems appropriate.

3. **Worker Lambda `homeops` table access.** The `homeops` table exists in `MessageStore` but the current `MessageProcessing` construct does not receive it as a prop and the Worker Lambda has no `HOMEOPS_TABLE_NAME` environment variable. Phase 3 will need to wire this: add `homeopsTable` as a prop to `MessageProcessing`, grant permissions, and set the environment variable. This is the same table that will be used for aliases, effort EMA, preferences, and patterns.

4. **Deep link payload tracking.** If the onboarding prompt uses `t.me/homeops_bot?start=onboard`, the bot receives `/start onboard` as the text. Should the payload be stored (to distinguish organic `/start` from prompted `/start`)? Low priority but potentially useful for analytics.

5. **Re-prompting strategy.** If a user is marked `prompted: true` but never opts in, should the system ever prompt again? The current recommendation says "never." An alternative is to reset `prompted` after 90 days. This is a product decision.

6. **Private chat messages that are not /start.** In Phase 3, non-/start private messages are ignored. In future phases, users might send commands or queries via DM. The Worker should log these messages for visibility but not process them. Should they be stored in the `messages` table? Probably yes, for auditability, but they should not trigger classification.
