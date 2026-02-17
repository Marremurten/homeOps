# Research: Telegram Bot API for Sending Responses

**Research question:** How should the HomeOps bot send responses back to Telegram group chats, and what are the API mechanics, permissions, rate limits, error codes, and detection patterns involved?

**Feature:** homeops-p2-classification (Phase 2)
**Date:** 2026-02-17

---

## Summary

The Telegram Bot API `sendMessage` method is the primary endpoint for sending text responses. It uses `reply_parameters` (replacing the older `reply_to_message_id`) to thread responses to specific messages, with `allow_sending_without_reply: true` as a safety net for deleted originals. The HomeOps bot, sending at most 3 messages per day per chat, operates well under Telegram's rate limits (20 messages/minute per group). Privacy mode must be **disabled** (or the bot made admin) so the bot receives all group messages for classification, but privacy mode does not affect the bot's ability to send messages.

---

## 1. sendMessage API

### Endpoint

```
POST https://api.telegram.org/bot<BOT_TOKEN>/sendMessage
```

Content-Type: `application/json`

### Parameters

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `chat_id` | Yes | Integer or String | Unique identifier for the target chat (negative for groups) |
| `text` | Yes | String | Text of the message, 1-4096 characters after entity parsing |
| `parse_mode` | No | String | `"HTML"`, `"MarkdownV2"`, or `"Markdown"` (legacy). Omit for plain text. |
| `entities` | No | Array of MessageEntity | List of special entities in the message text (alternative to parse_mode) |
| `link_preview_options` | No | LinkPreviewOptions | Options for link preview generation |
| `disable_notification` | No | Boolean | Send silently (no notification sound on client) |
| `protect_content` | No | Boolean | Protect message from forwarding/saving |
| `reply_parameters` | No | ReplyParameters | Description of the message to reply to |
| `reply_markup` | No | InlineKeyboardMarkup / ReplyKeyboardMarkup / etc. | Custom keyboard or inline buttons |
| `message_thread_id` | No | Integer | For supergroup topic threads |
| `business_connection_id` | No | String | For business bot connections (not relevant for HomeOps) |
| `message_effect_id` | No | String | Message effect animation (not relevant for HomeOps) |

### ReplyParameters Object

The modern replacement for the deprecated `reply_to_message_id` parameter.

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `message_id` | Yes | Integer | Identifier of the message to reply to |
| `chat_id` | No | Integer or String | If replying to a message in a different chat |
| `allow_sending_without_reply` | No | Boolean | If `true`, send the message even if the replied-to message is not found (deleted) |
| `quote` | No | String | Quoted part of the message to highlight |

### Request Example

```bash
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{
    "chat_id": -4001234567890,
    "text": "Noterat \u2705",
    "reply_parameters": {
      "message_id": 42,
      "allow_sending_without_reply": true
    }
  }'
```

### TypeScript Example (for Worker Lambda)

```typescript
interface SendMessageParams {
  chat_id: number;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2" | "Markdown";
  reply_parameters?: {
    message_id: number;
    allow_sending_without_reply?: boolean;
  };
  disable_notification?: boolean;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

interface SentMessage {
  message_id: number;
  from: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username: string;
  };
  chat: {
    id: number;
    type: string;
    title?: string;
  };
  date: number;
  text: string;
}

async function sendMessage(
  botToken: string,
  params: SendMessageParams
): Promise<TelegramApiResponse<SentMessage>> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }
  );
  return response.json() as Promise<TelegramApiResponse<SentMessage>>;
}
```

### Successful Response

```json
{
  "ok": true,
  "result": {
    "message_id": 43,
    "from": {
      "id": 7123456789,
      "is_bot": true,
      "first_name": "HomeOps",
      "username": "homeops_bot"
    },
    "chat": {
      "id": -4001234567890,
      "title": "Household Group",
      "type": "supergroup"
    },
    "date": 1708185660,
    "text": "Noterat \u2705"
  }
}
```

The `result.message_id` of the sent message is important -- store it so future user replies to this bot message can be detected via `reply_to_message.from.id`.

### Error Response

```json
{
  "ok": false,
  "error_code": 400,
  "description": "Bad Request: chat not found"
}
```

### Behavior When Original Message Was Deleted

If `reply_parameters.message_id` references a deleted message:

- **Without `allow_sending_without_reply: true`**: Returns `400 Bad Request` with `"message to be replied not found"`.
- **With `allow_sending_without_reply: true`**: Message is sent as a normal message (not a reply), no error.

**Recommendation:** Always set `allow_sending_without_reply: true`. The HomeOps bot processes messages asynchronously via SQS, so there is a small window where the original message could be deleted between ingestion and response. Sending a non-threaded acknowledgment is better than failing entirely.

### Character Limits

| Limit | Value |
|-------|-------|
| Message text | 4096 UTF-8 characters (after entity parsing) |
| Clarification question (PRD) | 5 words max |
| Acknowledgment (PRD) | 1 line max, 1 emoji max |

HomeOps responses are well under the 4096 limit. No splitting logic is needed.

---

## 2. Bot Group Chat Permissions

### Privacy Mode

Privacy mode controls which **incoming** messages a bot receives in group chats. It does **not** affect the bot's ability to **send** messages.

| Mode | Messages Received | Can Send? |
|------|-------------------|-----------|
| Privacy ON (default) | Commands (`/command@bot`), replies to bot messages, mentions of bot | Yes |
| Privacy OFF | All messages from humans (not from other bots) | Yes |
| Bot is admin | All messages from humans (not from other bots) | Yes |

**Critical for HomeOps:** The bot must classify **every** message in the group chat, not just commands or mentions. Therefore, privacy mode must be **disabled** via BotFather, or the bot must be added as a group admin.

### How to Disable Privacy Mode

1. Message `@BotFather` on Telegram
2. Send `/setprivacy`
3. Select your bot
4. Choose "Disable"
5. **Re-add the bot to the group** (required for the change to take effect)

### What the Bot Always Receives (Regardless of Privacy Mode)

- All messages in private (1:1) chats
- All service messages (member joined, member left, pinned message, etc.)
- All messages from channels where the bot is a member

### What the Bot Never Receives

- Messages from other bots (this is a hard Telegram platform restriction to prevent bot loops)

### Permissions Needed

For the HomeOps use case (passive observer + occasional responder):

| Permission | Needed? | Why |
|------------|---------|-----|
| Send Messages | Yes | To send acknowledgments and clarifications |
| Read Messages (privacy off) | Yes | To classify all messages |
| Admin status | Optional | Alternative to disabling privacy mode |
| Delete Messages | No | Bot never deletes user messages |
| Manage Chat | No | Not needed |
| Pin Messages | No | Not needed |

**Recommendation:** Disable privacy mode via BotFather (simplest). Do not make the bot an admin unless there is a separate reason to do so. Admin status grants more permissions than necessary.

### Detecting "Directly Addressed"

In privacy mode ON, Telegram itself filters and only delivers messages that address the bot. With privacy mode OFF (our case), the bot receives all messages and must detect "directly addressed" itself. See Section 6 below.

---

## 3. Rate Limits

### Official Limits (from Telegram Bot FAQ)

| Scope | Limit | Notes |
|-------|-------|-------|
| Per chat | ~1 message/second | Avoid sending more than 1 msg/sec to any single chat |
| Per group | 20 messages/minute | Hard limit for group chats |
| Global (broadcast) | ~30 messages/second | Across all chats, for bulk messaging |
| With Paid Broadcasts | ~1000 messages/second | Requires opt-in via BotFather |

**HomeOps impact:** The bot sends at most 3 messages per day per chat (PRD hard cap). This is roughly 6 orders of magnitude below the per-group rate limit. Rate limiting from Telegram's side is a non-concern for this use case.

### 429 Too Many Requests Response

When rate limits are exceeded, Telegram returns:

```json
{
  "ok": false,
  "error_code": 429,
  "description": "Too Many Requests: retry after 35",
  "parameters": {
    "retry_after": 35
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `error_code` | Integer | `429` |
| `description` | String | Human-readable, includes retry delay |
| `parameters.retry_after` | Integer | Seconds the bot must wait before any API call succeeds |

**Behavior during `retry_after`:** The bot is completely blocked for the specified duration. No API calls will succeed -- not just for the chat that triggered the limit, but for all chats.

### Handling 429 in HomeOps

Although extremely unlikely at 3 messages/day, the Worker Lambda should handle 429 gracefully:

```typescript
const result = await sendMessage(botToken, params);

if (!result.ok && result.error_code === 429) {
  const retryAfter = result.parameters?.retry_after ?? 30;
  console.warn("Telegram rate limited", { retryAfter, chatId: params.chat_id });
  // Do NOT retry in the Worker Lambda. Log and move on.
  // The message was classified and stored -- the response is optional.
  return;
}
```

**Recommendation:** Do NOT retry on 429. The bot's response is a nicety, not a critical operation. The classification and activity logging are the important parts. If a response fails, log it and move on. This aligns with the PRD's principle of "silence is a feature."

---

## 4. Error Codes

### Common Errors for sendMessage

| HTTP Code | `error_code` | `description` | Cause | Action |
|-----------|-------------|---------------|-------|--------|
| 200 | - | `ok: true` | Success | Store sent `message_id`, increment response counter |
| 400 | 400 | `Bad Request: chat not found` | Invalid `chat_id` or bot was never in the chat | Log error, do not retry. Possible data corruption. |
| 400 | 400 | `Bad Request: message to be replied not found` | `reply_parameters.message_id` references deleted/nonexistent message | Prevented by `allow_sending_without_reply: true` |
| 400 | 400 | `Bad Request: message text is empty` | Empty or whitespace-only `text` | Bug in response generation. Log error, do not retry. |
| 400 | 400 | `Bad Request: can't parse entities` | Invalid HTML/MarkdownV2 syntax in `text` | Bug in response generation. Log error, do not retry. Use plain text to avoid this. |
| 403 | 403 | `Forbidden: bot was kicked from the supergroup chat` | Bot was removed from the group | Log error, do not retry. Consider alerting. |
| 403 | 403 | `Forbidden: bot was blocked by the user` | User blocked the bot (private chats only) | Log error, do not retry. |
| 403 | 403 | `Forbidden: bot can't send messages to the chat` | Bot lacks permission to send messages in this chat | Log error, do not retry. Admin may have restricted bot. |
| 429 | 429 | `Too Many Requests: retry after N` | Rate limit exceeded | Log warning, do not retry (see Section 3). |
| 409 | 409 | `Conflict: terminated by other getUpdates request` | Webhook + polling conflict (should not happen) | Infrastructure misconfiguration. Alert. |
| 502 | 502 | Bad Gateway | Telegram server issue | Transient. Could retry once, but not critical. |

### Error Handling Strategy

```typescript
async function sendTelegramResponse(
  botToken: string,
  chatId: number,
  text: string,
  replyToMessageId: number
): Promise<{ sent: boolean; messageId?: number }> {
  const result = await sendMessage(botToken, {
    chat_id: chatId,
    text,
    reply_parameters: {
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
    },
  });

  if (result.ok && result.result) {
    return { sent: true, messageId: result.result.message_id };
  }

  const code = result.error_code ?? 0;
  const desc = result.description ?? "Unknown error";

  // Categorize: retryable vs permanent
  if (code === 429) {
    console.warn("Rate limited by Telegram", { chatId, retryAfter: result.parameters?.retry_after });
    // Do not retry -- response is optional
  } else if (code === 403) {
    console.error("Bot permission error", { chatId, description: desc });
    // Bot was kicked or blocked. Permanent for this chat.
    // Consider: mark chat as inactive to avoid future attempts
  } else if (code === 400) {
    console.error("Bad request to Telegram", { chatId, description: desc });
    // Likely a bug in our code (bad chat_id, empty text, parse error)
  } else {
    console.error("Unexpected Telegram error", { chatId, code, description: desc });
  }

  return { sent: false };
}
```

**Key principle from PRD:** "Failed Telegram sends logged but do not cause message processing retries." The SQS message should be considered successfully processed whether or not the Telegram response succeeded.

---

## 5. Best Practices

### For a Low-Volume Bot (max 3/day per chat)

1. **Use plain text, not MarkdownV2 or HTML.** The bot sends short Swedish acknowledgments ("Noterat") and clarification questions ("Menade du tvatt?"). Formatting is unnecessary and introduces parsing risk. If a message contains characters special to MarkdownV2 (e.g., `.`, `-`, `(`), they must be escaped or the API returns `400 Bad Request: can't parse entities`.

2. **Always set `allow_sending_without_reply: true`.** Messages are processed asynchronously. The original could be deleted before the bot responds.

3. **Do not use `disable_notification`.** The bot sends so rarely (max 3/day) that notifications are appropriate. Users should notice the bot's response.

4. **Store the `message_id` from the response.** When the bot sends a message, the response contains the `message_id` of the sent message. If a user later replies to this bot message, the incoming update's `message.reply_to_message.message_id` will match. This is essential for "directly addressed" detection.

5. **Use `fetch` (Node.js built-in), not an SDK.** The bot makes 0-3 API calls per day. Adding a Telegram SDK (telegraf, grammY, node-telegram-bot-api) for this is unnecessary overhead. A simple `fetch` wrapper with typed request/response is sufficient.

6. **Set a reasonable timeout on the fetch call.** The Telegram API is generally fast (<1s), but a 5-second timeout prevents the Worker Lambda from hanging if Telegram is slow.

### Message Formatting Options

| Mode | Syntax | Risk | Use Case |
|------|--------|------|----------|
| Plain text (no `parse_mode`) | None | None | Short text without formatting. **Recommended for HomeOps.** |
| HTML | `<b>bold</b>`, `<i>italic</i>`, `<a href="...">link</a>` | Must escape `<`, `>`, `&` | When formatting is needed |
| MarkdownV2 | `*bold*`, `_italic_`, `` `code` `` | Must escape many special chars: `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!` | Complex formatting |
| Markdown (legacy) | `*bold*`, `_italic_` | No nesting, limited features | Deprecated, avoid |

**Recommendation:** Use plain text. HomeOps responses are 1-5 words. No formatting is needed.

### Character Limit Considerations

- Text limit: 4096 characters after entity parsing.
- HomeOps max response: ~30 characters (e.g., "Menade du stadning?"). No risk of exceeding.
- If text exceeds 4096 characters, the API returns `400 Bad Request: message is too long`. Telegram does NOT automatically split; the caller must handle it. Not relevant for HomeOps.

---

## 6. Detecting "Directly Addressed"

The PRD states the bot may respond when "directly addressed." With privacy mode disabled, the bot receives all messages and must determine this itself. There are two mechanisms:

### 6.1. @mention Detection

When a user types `@homeops_bot` in a message, Telegram includes a `mention` entity in the message's `entities` array.

**Incoming message example:**

```json
{
  "message_id": 55,
  "from": { "id": 111222333, "is_bot": false, "first_name": "Martin", "username": "martinnordlund" },
  "chat": { "id": -4001234567890, "type": "supergroup" },
  "date": 1708185700,
  "text": "@homeops_bot vem diskade sist?",
  "entities": [
    {
      "type": "mention",
      "offset": 0,
      "length": 14
    }
  ]
}
```

**Detection logic:**

```typescript
function isBotMentioned(
  message: TelegramMessage,
  botUsername: string
): boolean {
  if (!message.entities || !message.text) return false;

  for (const entity of message.entities) {
    if (entity.type === "mention") {
      // Extract the mention text from the message
      const mentionText = message.text.substring(
        entity.offset,
        entity.offset + entity.length
      );
      // Compare case-insensitively (Telegram usernames are case-insensitive)
      if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
        return true;
      }
    }
    // text_mention: for users without a username, Telegram uses this entity
    // type with a nested `user` object. Not typical for bots (bots always
    // have usernames), but handle it for robustness.
    if (entity.type === "text_mention" && "user" in entity) {
      const user = (entity as MessageEntityWithUser).user;
      if (user.is_bot && user.username?.toLowerCase() === botUsername.toLowerCase()) {
        return true;
      }
    }
  }
  return false;
}
```

**Entity types relevant for "directly addressed":**

| Entity Type | Trigger | Example | `user` Field |
|-------------|---------|---------|-------------|
| `mention` | User typed `@username` | `@homeops_bot` | No (extract from text) |
| `text_mention` | User mentioned a user without a username | Rare for bots (bots always have usernames) | Yes (contains `User` object) |
| `bot_command` | User typed `/command` | `/start@homeops_bot` | No |

### 6.2. Reply-to-Bot Detection

When a user replies to a previous bot message, the incoming message has a `reply_to_message` field containing the original message. Check if the original was from the bot.

**Incoming message example (reply to bot):**

```json
{
  "message_id": 57,
  "from": { "id": 111222333, "is_bot": false, "first_name": "Martin" },
  "chat": { "id": -4001234567890, "type": "supergroup" },
  "date": 1708185800,
  "text": "Ja, tvatt",
  "reply_to_message": {
    "message_id": 43,
    "from": {
      "id": 7123456789,
      "is_bot": true,
      "first_name": "HomeOps",
      "username": "homeops_bot"
    },
    "chat": { "id": -4001234567890, "type": "supergroup" },
    "date": 1708185660,
    "text": "Menade du tvatt?"
  }
}
```

**Detection logic:**

```typescript
function isReplyToBot(
  message: TelegramMessage,
  botId: number
): boolean {
  return (
    message.reply_to_message !== undefined &&
    message.reply_to_message.from !== undefined &&
    message.reply_to_message.from.id === botId
  );
}
```

**Note:** The `reply_to_message` field is a nested `Message` object, but it will NOT contain a further `reply_to_message` field (only one level deep).

### 6.3. Getting the Bot's Own ID and Username

To compare against incoming entities, the bot needs to know its own `id` and `username`. Call `getMe` once at cold start:

```
GET https://api.telegram.org/bot<BOT_TOKEN>/getMe
```

Response:

```json
{
  "ok": true,
  "result": {
    "id": 7123456789,
    "is_bot": true,
    "first_name": "HomeOps",
    "username": "homeops_bot",
    "can_join_groups": true,
    "can_read_all_group_messages": true,
    "supports_inline_queries": false
  }
}
```

Cache `id` and `username` at module scope (same pattern as secrets caching). The bot's identity never changes during a Lambda execution environment's lifetime.

### 6.4. Combined "Directly Addressed" Check

```typescript
function isDirectlyAddressed(
  message: TelegramMessage,
  botId: number,
  botUsername: string
): boolean {
  return (
    isBotMentioned(message, botUsername) ||
    isReplyToBot(message, botId)
  );
}
```

### 6.5. Types Needed for Detection

The existing `TelegramMessage` type in `/Users/martinnordlund/homeOps/src/shared/types/telegram.ts` already has `entities?: MessageEntity[]` but is missing `reply_to_message`. The `MessageEntity` type exists but lacks the `user` field needed for `text_mention`. These types need extension for Phase 2:

```typescript
// Extensions needed for Phase 2

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;  // Present for text_mention entities
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  entities?: MessageEntity[];
  reply_to_message?: TelegramMessage;  // New: for reply detection
  photo?: unknown[];
  edit_date?: number;
}
```

---

## Recommendation

### Architecture for Sending Responses

The Worker Lambda already processes SQS messages and writes to DynamoDB. Add the Telegram response step as the final step in the pipeline:

```
SQS message received
  -> Parse message body
  -> Write raw message to DynamoDB (existing)
  -> Call OpenAI for classification (new, Phase 2)
  -> If response policy allows:
      -> Check response counter (DynamoDB)
      -> Check silence rules (fast conversation, quiet hours, etc.)
      -> Send via Telegram Bot API (sendMessage)
      -> Increment response counter
      -> Store sent message_id (for future reply detection)
  -> Return success (even if Telegram send failed)
```

### Concrete Technical Decisions

1. **Use `reply_parameters` (not the deprecated `reply_to_message_id`).** Modern API, supports `allow_sending_without_reply`.

2. **Always set `allow_sending_without_reply: true`.** Prevents failures when original messages are deleted.

3. **Use plain text (no `parse_mode`).** Eliminates parsing errors for short Swedish text.

4. **Disable privacy mode via BotFather.** The bot needs all messages for classification. Simpler than making the bot admin.

5. **Cache bot identity (`getMe`) at module scope.** Call once per cold start, cache `id` and `username`.

6. **Use native `fetch` with a 5-second timeout.** No SDK needed for 0-3 API calls per day.

7. **Never retry failed sends.** Log the error and mark the SQS message as processed. Classification and activity logging are the critical path; the response is optional.

8. **Store the sent `message_id`.** Needed for future "reply to bot" detection. Store alongside the response counter or in the activities table.

---

## Trade-offs

| Decision | What We Gain | What We Give Up |
|----------|-------------|-----------------|
| Plain text over MarkdownV2 | No parsing errors, simpler code | Cannot bold/italic in responses (not needed per PRD) |
| `allow_sending_without_reply: true` | Resilience to deleted messages | Response may appear unthreaded if original was deleted |
| Disable privacy mode (not admin) | All messages received, minimal permissions | Must re-add bot to group after changing setting |
| No retry on send failure | Simpler code, no retry storms | Occasional missed responses (acceptable per PRD) |
| `fetch` over SDK | No dependency, minimal code | Must handle types and error parsing manually |
| Cache `getMe` at cold start | Fast detection, no per-request overhead | Extra ~100ms on cold start; bot identity change requires redeploy |

---

## Open Questions

1. **Where to store the bot's sent `message_id`?** Options: (a) Add a `botResponseMessageId` field to the activities table, (b) Create a separate `bot_messages` tracking table, (c) Store in the response_counters table. Option (a) is simplest since it ties the response directly to the activity that triggered it.

2. **Should we call `getMe` on every cold start, or configure `botId`/`botUsername` as environment variables?** Environment variables are simpler and avoid an API call, but they could drift if the bot is reconfigured. Calling `getMe` is more robust but adds cold start latency. At the low throughput HomeOps operates at, the extra 100ms is negligible.

3. **How to handle the bot being kicked from a group (403)?** Should the system mark the chat as inactive to prevent further processing attempts, or just log and let future messages fail the same way? For Phase 2, logging is sufficient. Phase 3+ might add chat lifecycle management.

4. **Timeout for the Telegram API call.** Node.js `fetch` does not have a built-in timeout. Use `AbortController` with `setTimeout` for a 5-second deadline. Alternatively, the overall Lambda timeout (currently set to handle SQS processing) provides a backstop.

5. **`reply_to_message` field in webhook payloads for privacy-disabled bots.** When privacy mode is off and a user replies to another human's message (not the bot's), does the webhook payload include `reply_to_message`? Yes, it does -- the field is present on any message that is a reply, regardless of who the reply targets. The detection logic must specifically check `reply_to_message.from.id === botId`, not just the existence of `reply_to_message`.
