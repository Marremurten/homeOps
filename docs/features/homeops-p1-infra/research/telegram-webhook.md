# Research: Telegram Bot API Webhook Integration with AWS API Gateway

**Research question:** How should Telegram Bot API webhooks integrate with AWS API Gateway for a serverless message ingestion pipeline?

**Feature:** homeops-p1-infra (Phase 1)
**Date:** 2026-02-17

---

## Summary

Telegram delivers webhook updates as HTTPS POST requests containing JSON-serialized Update objects. The integration requires an API Gateway HTTP API (not REST API) with a single POST route proxied to an Ingest Lambda, which validates the `X-Telegram-Bot-Api-Secret-Token` header, extracts the message, enqueues to SQS, and returns 200 immediately. For TypeScript types, the `@telegraf/types` standalone package provides auto-updated, zero-runtime Telegram API types that can be used without importing the full Telegraf framework.

---

## 1. Webhook Registration

### setWebhook

Register the webhook by calling:

```
POST https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
```

**Parameters:**

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `url` | Yes | String | HTTPS URL for the webhook endpoint. Empty string removes the webhook. |
| `certificate` | No | InputFile | Public key certificate for self-signed certs. Not needed with a valid CA cert (API Gateway uses AWS-managed certs). |
| `ip_address` | No | String | Fixed IP for webhook delivery instead of DNS resolution. Not needed. |
| `max_connections` | No | Integer | 1-100, default 40. Concurrent HTTPS connections for update delivery. |
| `allowed_updates` | No | Array of String | Filter which update types to receive. |
| `drop_pending_updates` | No | Boolean | Drop queued updates when setting new webhook. Useful during initial setup. |
| `secret_token` | No | String | 1-256 chars, `[A-Za-z0-9_-]` only. Sent as `X-Telegram-Bot-Api-Secret-Token` header on every request. |

**Supported ports:** 443, 80, 88, 8443. API Gateway uses 443 by default, so no issue.

**Registration script example:**

```bash
#!/usr/bin/env bash
# scripts/register-webhook.sh

BOT_TOKEN="${BOT_TOKEN:?Missing BOT_TOKEN}"
WEBHOOK_URL="${WEBHOOK_URL:?Missing WEBHOOK_URL}"
SECRET_TOKEN="${SECRET_TOKEN:?Missing SECRET_TOKEN}"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "'"${WEBHOOK_URL}"'",
    "secret_token": "'"${SECRET_TOKEN}"'",
    "allowed_updates": ["message"],
    "drop_pending_updates": true,
    "max_connections": 10
  }'
```

Key decisions in this script:
- `allowed_updates: ["message"]` -- only receive new messages, not edited messages, callbacks, inline queries, etc.
- `drop_pending_updates: true` -- clean slate on (re-)registration
- `max_connections: 10` -- conservative; a single Lambda behind API Gateway can scale independently, and we do not need 40 concurrent connections

### deleteWebhook

```
POST https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook
```

Single optional parameter: `drop_pending_updates` (boolean). Use this to cleanly remove the webhook, e.g., before switching to polling during development.

### getWebhookInfo

```
GET https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

Returns a `WebhookInfo` object -- essential for debugging:

```json
{
  "ok": true,
  "result": {
    "url": "https://abc123.execute-api.eu-north-1.amazonaws.com/webhook",
    "has_custom_certificate": false,
    "pending_update_count": 0,
    "last_error_date": 1711346679,
    "last_error_message": "Connection timed out",
    "max_connections": 10,
    "allowed_updates": ["message"]
  }
}
```

Monitor `pending_update_count` and `last_error_message` to catch delivery issues early.

---

## 2. Update Payload Structure

### Update Object

An Update has exactly one of ~20+ optional fields set, plus the required `update_id`. For Phase 1 we only care about the `message` field.

**Complete Update optional fields (as of Bot API 8.x):**

| Field | Description | Relevant? |
|-------|-------------|-----------|
| `message` | New incoming message (text, photo, sticker, etc.) | **Yes** |
| `edited_message` | Edited version of a known message | No (Phase 1) |
| `channel_post` | New incoming channel post | No |
| `edited_channel_post` | Edited channel post | No |
| `business_connection` | Business connection update | No |
| `business_message` | New business message | No |
| `edited_business_message` | Edited business message | No |
| `deleted_business_messages` | Deleted business messages | No |
| `message_reaction` | Reaction changed on a message | No |
| `message_reaction_count` | Anonymous reaction count changed | No |
| `inline_query` | Incoming inline query | No |
| `chosen_inline_result` | Result of inline query chosen by user | No |
| `callback_query` | Incoming callback query (button press) | No |
| `shipping_query` | Incoming shipping query | No |
| `pre_checkout_query` | Incoming pre-checkout query | No |
| `purchased_paid_media` | Paid media purchase | No |
| `poll` | Poll state changed | No |
| `poll_answer` | User changed poll answer | No |
| `my_chat_member` | Bot's chat member status changed | No |
| `chat_member` | Chat member status changed | No |
| `chat_join_request` | Join request sent to chat | No |
| `chat_boost` | Chat boost added | No |
| `removed_chat_boost` | Chat boost removed | No |

### Example Webhook Payload (text message in group chat)

```json
{
  "update_id": 123456789,
  "message": {
    "message_id": 42,
    "from": {
      "id": 111222333,
      "is_bot": false,
      "first_name": "Martin",
      "last_name": "Nordlund",
      "username": "martinnordlund",
      "language_code": "en"
    },
    "chat": {
      "id": -4001234567890,
      "title": "Household Group",
      "type": "supergroup"
    },
    "date": 1708185600,
    "text": "Can someone pick up milk?"
  }
}
```

### Fields We Need to Extract (per PRD DynamoDB schema)

| DynamoDB Attribute | Source Path | Type |
|-------------------|-------------|------|
| `chatId` (PK) | `message.chat.id` | Number (as String) |
| `messageId` (SK) | `message.message_id` | Number |
| `userId` | `message.from.id` | Number |
| `userName` | `message.from.username` or `message.from.first_name` | String |
| `text` | `message.text` | String |
| `timestamp` | `message.date` (Unix seconds) | Number |
| `raw` | Full update JSON | String (JSON) |
| `createdAt` | Lambda execution time | String (ISO 8601) |

### Filtering Logic

The Ingest Lambda must filter at two levels:

1. **Update-level:** Only process updates that have the `message` field. Reject (but return 200 for) updates with `edited_message`, `callback_query`, etc.
2. **Message-level:** Only process messages with a `text` field. A `message` update can be a photo, sticker, document, etc. with no `text`. For Phase 1, skip non-text messages.

```typescript
// Pseudocode for filtering
function shouldProcess(update: Update): boolean {
  // Must have message field (not edited_message, callback_query, etc.)
  if (!update.message) return false;

  // Must have text content (not photo, sticker, etc.)
  if (!update.message.text) return false;

  // Must have required fields for DynamoDB schema
  if (!update.message.from || !update.message.chat) return false;

  return true;
}
```

**Important:** Even when we skip an update, we must return HTTP 200. Otherwise Telegram will retry delivery.

---

## 3. Secret Token Validation

### How It Works

1. During `setWebhook`, you provide a `secret_token` value (1-256 chars, `[A-Za-z0-9_-]`).
2. Telegram includes the header `X-Telegram-Bot-Api-Secret-Token` with that exact value on every webhook POST.
3. The Ingest Lambda validates the header matches the expected secret.

### Where to Store the Secret

Store the `secret_token` in AWS Secrets Manager alongside the bot token. The Ingest Lambda retrieves it at cold start and caches it for the lifetime of the execution environment.

### Validation in Lambda

```typescript
// Pseudocode for secret token validation

// Cached at cold start
let cachedSecretToken: string | undefined;

async function getSecretToken(): Promise<string> {
  if (cachedSecretToken) return cachedSecretToken;
  // Fetch from Secrets Manager
  const secret = await secretsManager.getSecretValue({
    SecretId: 'homeops/telegram-bot'
  });
  const parsed = JSON.parse(secret.SecretString!);
  cachedSecretToken = parsed.webhookSecretToken;
  return cachedSecretToken;
}

export async function handler(event: APIGatewayProxyEventV2) {
  // Header names are lowercased in payload format 2.0
  const headerToken = event.headers['x-telegram-bot-api-secret-token'];
  const expectedToken = await getSecretToken();

  if (!headerToken || headerToken !== expectedToken) {
    // Return 401 (not 200!) -- this is NOT a valid Telegram request.
    // Telegram itself always sends the correct token. A mismatch means
    // someone else is hitting the endpoint. We want them to get a rejection.
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // ... proceed with update processing
}
```

**Key detail:** API Gateway HTTP API (payload format 2.0) lowercases all header names. The header arrives as `x-telegram-bot-api-secret-token`, not `X-Telegram-Bot-Api-Secret-Token`.

### Security Consideration

The secret token is the primary defense against spoofed requests. Without it, anyone who discovers the API Gateway URL could inject fake updates. The token should be:
- Generated as a cryptographically random string (e.g., 64 chars)
- Stored in Secrets Manager (not environment variables)
- Rotated by re-calling `setWebhook` with a new token + updating Secrets Manager

---

## 4. API Gateway Integration

### HTTP API vs REST API

| Factor | HTTP API (v2) | REST API (v1) |
|--------|--------------|---------------|
| **Pricing** | $1.00/million requests | $3.50/million requests |
| **Latency** | ~10ms overhead (p99) | Higher overhead |
| **Payload format** | 2.0 (simpler event) | 1.0 (verbose event) |
| **WAF support** | No | Yes |
| **API keys** | No | Yes |
| **Request validation** | No | Yes |
| **Usage plans / throttling** | No | Yes |
| **CDK construct** | `HttpApi` | `RestApi` |

**Decision: HTTP API.** Reasons:
- 71% cheaper per request
- Lower latency (important for the <2s end-to-end target)
- Simpler event format (payload format 2.0)
- We do not need WAF, API keys, or request validation at the gateway level -- the Lambda does its own validation via secret token
- The endpoint is public by design (Telegram requires this)

### Payload Format 2.0 Event Structure

With HTTP API and payload format 2.0, the Lambda receives:

```typescript
// APIGatewayProxyEventV2 (from @types/aws-lambda)
{
  version: '2.0',
  routeKey: 'POST /webhook',
  rawPath: '/webhook',
  rawQueryString: '',
  headers: {
    'content-type': 'application/json',
    'x-telegram-bot-api-secret-token': 'your-secret-here',
    // ... other headers (all lowercased)
  },
  requestContext: {
    http: {
      method: 'POST',
      path: '/webhook',
      protocol: 'HTTP/1.1',
      sourceIp: '149.154.160.0',  // Telegram server IP
      userAgent: '...'
    },
    // ...
  },
  body: '{"update_id":123456789,"message":{...}}',
  isBase64Encoded: false
}
```

The Telegram Update JSON is in `event.body` as a string -- parse it with `JSON.parse(event.body)`.

### CDK Configuration

```typescript
// Pseudocode for CDK stack

import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const api = new HttpApi(this, 'TelegramWebhookApi', {
  apiName: 'homeops-telegram-webhook',
  description: 'Receives Telegram webhook updates',
});

const ingestIntegration = new HttpLambdaIntegration(
  'IngestIntegration',
  ingestLambda
);

api.addRoutes({
  path: '/webhook',
  methods: [HttpMethod.POST],
  integration: ingestIntegration,
});

// Health check on a separate route
api.addRoutes({
  path: '/health',
  methods: [HttpMethod.GET],
  integration: new HttpLambdaIntegration('HealthIntegration', healthLambda),
});

// The webhook URL to register with Telegram:
// https://<api-id>.execute-api.eu-north-1.amazonaws.com/webhook
```

### Lambda Response Format (2.0)

With payload format 2.0, the Lambda can return a simplified response. API Gateway infers defaults:

```typescript
// Minimal -- API Gateway infers statusCode 200 and content-type
return { statusCode: 200, body: JSON.stringify({ ok: true }) };
```

---

## 5. Retry Behavior

### Telegram's Retry Policy

From the official documentation:

> In case of an unsuccessful request (a request with response HTTP status code different from 2XX), the Bot API server will give up after a reasonable amount of attempts.

The exact retry policy is intentionally unspecified by Telegram, but community observations indicate:

- Telegram retries with **exponential backoff**
- After repeated failures over **several hours**, Telegram **disables the webhook entirely**
- `getWebhookInfo` shows `pending_update_count` (queued updates) and `last_error_message`
- Updates are delivered **in order** -- a failed update blocks subsequent updates

### Why This Matters for Our Architecture

This is the primary reason the PRD specifies an SQS queue between the Ingest Lambda and Worker Lambda:

```
Telegram --> API Gateway --> Ingest Lambda --> SQS --> Worker Lambda --> DynamoDB
                                  |
                                  +-- Returns 200 IMMEDIATELY
```

If the Ingest Lambda tried to write directly to DynamoDB and failed (throttling, transient error), it would return a non-2xx response. Telegram would then:
1. Retry the same update (creating unnecessary load)
2. Block all subsequent updates until the retry succeeds
3. Eventually disable the webhook if failures persist

By enqueueing to SQS and returning 200 immediately:
- Telegram never retries (it considers delivery successful)
- SQS handles retry logic for downstream failures (with its own DLQ)
- Updates flow continuously even if DynamoDB has transient issues
- The Ingest Lambda is extremely fast (validate + enqueue = ~50-100ms)

### Timeout Consideration

Telegram has an undocumented but observed ~30-second timeout for webhook responses. Our Ingest Lambda should complete well under that. Target: <500ms for the entire validate-and-enqueue operation. Lambda timeout should be set to 10 seconds as a generous upper bound.

---

## 6. Error Handling

### Decision Matrix

| Scenario | Action | HTTP Response | Why |
|----------|--------|---------------|-----|
| Valid message update | Enqueue to SQS, return success | 200 | Normal flow |
| Valid but non-message update (e.g., edited_message) | Skip, return success | 200 | Must not trigger retries |
| Valid message but no `text` field (photo, sticker) | Skip, return success | 200 | Phase 1: text only |
| Missing `X-Telegram-Bot-Api-Secret-Token` | Reject | 401 | Not from Telegram |
| Wrong secret token | Reject | 401 | Not from Telegram |
| Malformed JSON body | Log warning, return success | 200 | Avoid retry storm |
| Missing `update_id` | Log warning, return success | 200 | Malformed but do not retry |
| SQS `sendMessage` fails | Return error | 500 | Let Telegram retry -- SQS is our critical path |

### Key Principle

**Return 200 for anything that came from Telegram** (validated by secret token), even if we cannot process it. The only exception is an SQS failure, which is the one case where we actually want Telegram to retry because the message was not durably captured.

### Malformed Update Handling

```typescript
// Pseudocode

function parseUpdate(body: string): TelegramUpdate | null {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.update_id !== 'number') {
      console.warn('Missing update_id', { body: body.substring(0, 500) });
      return null;
    }
    return parsed as TelegramUpdate;
  } catch (e) {
    console.warn('Malformed JSON body', { error: e.message });
    return null;
  }
}

// In handler:
const update = parseUpdate(event.body ?? '');
if (!update) {
  return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
}
```

### Structured Logging

Every invocation should log:
- `update_id` (for correlation)
- `action` taken (enqueued, skipped, rejected)
- `reason` for skipping/rejection
- `duration_ms` for performance monitoring

---

## 7. TypeScript Types

### Options Evaluated

| Option | Package | Pros | Cons |
|--------|---------|------|------|
| `@telegraf/types` | Standalone types package | Auto-updated with Bot API, zero runtime, full type coverage, union types for narrowing | Includes types for the entire API (large surface) |
| `@types/node-telegram-bot-api` | DefinitelyTyped | Community maintained | Often lags behind API updates, tied to node-telegram-bot-api patterns |
| Custom minimal types | None | Exactly what we need, no dependencies | Must maintain manually, could drift from API |

### Recommendation: Custom Minimal Types

For Phase 1, define minimal custom types covering only the fields we use. Rationale:

1. **We only need ~5 types** (Update, Message, User, Chat, and our SQS message envelope). Installing `@telegraf/types` brings hundreds of types we never reference.
2. **Zero dependency risk.** No package to update, no breaking changes from upstream.
3. **Explicit contract.** The types document exactly what fields we depend on, making the validation logic obvious.
4. **Easy to extend.** In Phase 2+ when we need more Telegram types (e.g., for sending messages), we can switch to `@telegraf/types` at that point.

### Suggested Type Definitions

```typescript
// src/types/telegram.ts

/**
 * Minimal Telegram Bot API types for webhook ingestion.
 * Covers only the fields HomeOps Phase 1 actually uses.
 * Reference: https://core.telegram.org/bots/api#update
 */

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  // All other update types (edited_message, callback_query, etc.)
  // are intentionally omitted -- we filter them out.
  // Adding an index signature allows us to detect their presence:
  [key: string]: unknown;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;   // Optional per API spec (e.g., channel posts)
  chat: TelegramChat;
  date: number;           // Unix timestamp (seconds)
  text?: string;          // Only present for text messages
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;         // Present for groups/supergroups/channels
  username?: string;      // Present for private chats and some groups
  first_name?: string;    // Present for private chats
}

/**
 * The message shape we enqueue to SQS.
 * Normalized from the raw Telegram update.
 */
export interface IngestMessage {
  updateId: number;
  messageId: number;
  chatId: number;
  userId: number;
  userName: string;       // username || first_name as fallback
  text: string;
  timestamp: number;      // Unix seconds from Telegram
  raw: string;            // Full update JSON for debugging/replay
}
```

### Type Guard for Validation

```typescript
// src/lib/validate.ts

import type { TelegramUpdate, TelegramMessage } from '../types/telegram.js';

export function isTextMessage(
  update: TelegramUpdate
): update is TelegramUpdate & { message: TelegramMessage & { text: string; from: TelegramUser } } {
  return (
    update.message !== undefined &&
    typeof update.message.text === 'string' &&
    update.message.from !== undefined &&
    typeof update.message.chat?.id === 'number'
  );
}
```

---

## Recommendations

### Concrete Decisions

1. **Use HTTP API (not REST API) for API Gateway.** 71% cheaper, lower latency, simpler event format. We do not need WAF, API keys, or request validation at the gateway level.

2. **Set `allowed_updates: ["message"]` when registering the webhook.** This reduces traffic to only new messages. Telegram will not send edited messages, callbacks, reactions, etc. This is the first line of filtering -- the Lambda still validates, but receives far less irrelevant traffic.

3. **Use `secret_token` for webhook authentication.** Store a cryptographically random 64-character token in Secrets Manager. Validate the `x-telegram-bot-api-secret-token` header (lowercased in HTTP API payload format 2.0) on every request. Return 401 for mismatches.

4. **Return 200 for all valid Telegram requests,** even if we skip the update. Only return non-2xx if (a) secret token validation fails (401) or (b) SQS enqueue fails (500, to trigger Telegram retry).

5. **Define custom minimal TypeScript types** for Phase 1. Five small interfaces covering exactly the fields we use. Switch to `@telegraf/types` in Phase 2 if needed when we add send-message capabilities.

6. **Use payload format 2.0** (default for HTTP API). Simpler event structure, lowercased headers, and the Lambda can return minimal JSON.

7. **Create a webhook management script** (`scripts/register-webhook.sh` or a TypeScript CLI) that wraps `setWebhook`, `deleteWebhook`, and `getWebhookInfo`. This is a manual prerequisite, not automated in CDK.

8. **Set Lambda timeout to 10 seconds** for the Ingest Lambda. The actual execution should be <500ms (validate + SQS send), but 10s gives margin. Telegram's observed timeout is ~30s.

### Trade-offs

| Decision | What We Gain | What We Give Up |
|----------|-------------|-----------------|
| HTTP API over REST API | Lower cost, lower latency | No WAF, no API keys, no built-in request validation |
| `allowed_updates: ["message"]` | Less Lambda invocations, less noise | Cannot process edited messages, reactions without re-registering webhook |
| Custom types over `@telegraf/types` | Zero dependencies, explicit contract | Must maintain types manually, risk of drift if Telegram API changes |
| Return 200 for skipped updates | No retry storms | Silently drops updates we do not handle (correct for Phase 1) |
| Secret token in Secrets Manager | Secure, rotatable | Cold start latency (~50-100ms) on first invocation to fetch secret |

### Open Questions

1. **Secret token rotation strategy.** How to rotate the secret token without downtime? Approach: update Secrets Manager, then call `setWebhook` with the new token. During the brief window, accept both old and new tokens? Or accept a few seconds of 401s?

2. **Telegram server IP allowlisting.** Telegram publishes IP ranges (149.154.160.0/20, 91.108.4.0/22) for webhook requests. Should we add IP-based restrictions at the API Gateway level? HTTP API does not support WAF, so this would need a CloudFront distribution in front, which adds complexity. The secret token is likely sufficient for Phase 1.

3. **`max_connections` tuning.** Default is 40. For a low-traffic household group chat, 10 is generous. But should we set it even lower (e.g., 5) to avoid Lambda concurrency spikes during Telegram's retry bursts?

4. **Monitoring webhook health.** Should we add a periodic CloudWatch Events / EventBridge rule that calls `getWebhookInfo` and alarms on high `pending_update_count` or non-empty `last_error_message`? This would catch webhook failures before users notice messages are not being recorded.
