# Codebase Analysis: HomeOps Phase 1 Infrastructure & Phase 2 Integration Points

**Research Date:** 2026-02-17
**Target Phase:** Phase 2 - Message Understanding & Activity Logging
**Project Root:** `/Users/martinnordlund/homeOps`

## Executive Summary

Phase 1 establishes a lean, event-driven pipeline: Telegram webhook → API Gateway HTTP API → Ingest Lambda (validation + SQS enqueue) → Worker Lambda (raw message storage). Phase 2 extends the Worker Lambda to add classification logic and event logging. This document maps all Phase 1 infrastructure and identifies exact integration points for Phase 2.

---

## 1. Worker Lambda Handler

**File:** `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts`

### Current Logic

The Worker Lambda is triggered by SQS event source mapping (batch size 1, with `reportBatchItemFailures: true`). Current implementation:

1. **Receives:** SQS `SQSEvent` with records containing `MessageBody` as JSON
2. **Parses:** Message body with fields: `chatId`, `messageId`, `userId`, `userName`, `text`, `timestamp`
3. **Enriches:** Adds `createdAt` (ISO 8601) and `ttl` (Unix epoch, +90 days)
4. **Stores:** Single PutItemCommand to DynamoDB with conditional write (`attribute_not_exists(chatId) AND attribute_not_exists(messageId)`)
5. **Error Handling:** Catches `ConditionalCheckFailedException` (duplicate from Telegram retry) and treats as success; other errors throw to trigger SQS retry

### Interface Definition

```typescript
interface MessageBody {
  chatId: string;
  messageId: number;
  userId: number;
  userName: string;
  text: string;
  timestamp: number;
}
```

### Item Schema Written to DynamoDB

```
chatId (S): String representation of chat ID
messageId (N): Number as string
userId (N): Number as string
userName (S): User display name
text (S): Message text
timestamp (N): Unix timestamp from Telegram (seconds)
raw (S): Full SQS record body as JSON
createdAt (S): ISO 8601 datetime
ttl (N): Unix epoch seconds (createdAt + 90 days)
```

### Integration Point for Phase 2

**Insert classification logic AFTER successful PutItem, BEFORE function returns:**

```
1. Parse text + metadata from message record
2. Call OpenAI API for classification
3. If classification succeeds:
   a. Write to activities table (if type = chore/recovery)
   b. Check/increment response_counters (if responding)
   c. Call Telegram Bot API (if policy allows)
4. If classification fails:
   a. Log error (do NOT throw — must not block DynamoDB write)
   b. Continue to next record
```

**Critical:** The DynamoDB raw message write must succeed and return 200 to SQS BEFORE attempting external API calls. If OpenAI or Telegram calls fail, those failures must be logged but NOT cause the handler to throw (which would trigger SQS retry). The raw message is already safely persisted.

---

## 2. CDK Stack Infrastructure

**Root File:** `/Users/martinnordlund/homeOps/infra/stack.ts`

### Existing Resources Created

#### 2.1 DynamoDB Tables

**MessageStore Construct** (`/Users/martinnordlund/homeOps/infra/constructs/message-store.ts`)

1. **`homeops-messages` Table**
   - **PK:** `chatId` (String)
   - **SK:** `messageId` (Number)
   - **Billing:** PAY_PER_REQUEST (on-demand)
   - **TTL:** Enabled on `ttl` attribute
   - **PITR:** Enabled
   - **Attributes stored by Worker:** chatId, messageId, userId, userName, text, timestamp, raw, createdAt, ttl

2. **`homeops` Table** (single-table-design for Phase 2+)
   - **PK:** `pk` (String)
   - **SK:** `sk` (String)
   - **GSI 1:** `gsi1pk` (PK), `gsi1sk` (SK)
   - **Billing:** PAY_PER_REQUEST
   - **PITR:** Enabled
   - **Purpose:** Will hold activities, response_counters, and other entities in Phase 2+

#### 2.2 SQS Queues

**MessageProcessing Construct** (`/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts`)

1. **Main Queue**
   - **Type:** Standard (not FIFO)
   - **Visibility Timeout:** 180 seconds
   - **Retention Period:** 4 days (default)
   - **Dead Letter Queue:** Yes, with maxReceiveCount = 3
   - **Event Source Mapping to Worker:** Batch size = 1, reportBatchItemFailures = true

2. **Dead Letter Queue**
   - **Retention Period:** 14 days (AWS maximum)
   - **CloudWatch Alarm:** Triggers on `ApproximateNumberOfMessagesVisible > 0`

#### 2.3 Lambda Functions

**Three Lambda functions created by CDK:**

1. **Ingest Lambda** (IngestionApi construct)
   - **Path:** `src/handlers/ingest/index.ts`
   - **Runtime:** Node.js 22 X (ARM64)
   - **Timeout:** 10 seconds
   - **Memory:** 256 MB
   - **Environment:** `SQS_QUEUE_URL`, `WEBHOOK_SECRET_ARN`
   - **Permissions:** SendMessage to SQS, Read secret

2. **Worker Lambda** (MessageProcessing construct)
   - **Path:** `src/handlers/worker/index.ts`
   - **Runtime:** Node.js 22 X (ARM64)
   - **Timeout:** 30 seconds
   - **Memory:** 256 MB
   - **Environment:** `MESSAGES_TABLE_NAME`
   - **Permissions:** PutItem on messages table
   - **Event Source:** SQS (batch size 1, report failures)

3. **Health Lambda** (IngestionApi construct)
   - **Path:** `src/handlers/health/index.ts`
   - **Runtime:** Node.js 22 X (ARM64)
   - **Timeout:** 10 seconds
   - **Memory:** 256 MB
   - **Environment:** `DEPLOY_VERSION`
   - **Purpose:** Health check endpoint for monitoring

#### 2.4 API Gateway

**HttpApi** (IngestionApi construct)

- **Type:** API Gateway V2 HTTP API (not REST API)
- **Routes:**
  - `POST /webhook` → Ingest Lambda
  - `GET /health` → Health Lambda
- **Payload Format:** 2.0 (headers lowercased)

#### 2.5 Secrets Manager

**Three secrets created by stack:**

1. `homeops/telegram-bot-token` — Telegram bot token (Phase 2 will use for sendMessage)
2. `homeops/webhook-secret` — Webhook HMAC secret (used by Ingest Lambda)
3. `homeops/openai-api-key` — OpenAI API key (Phase 2 will use for classification)

#### 2.6 CloudWatch

- **Log Groups:** 30-day retention for all Lambda functions
- **Alarms:** DLQ depth (1), Worker errors (1)

### How to Extend for Phase 2

#### Phase 2 Table Creation

**Modify MessageStore construct** to add two new tables:

```typescript
// 1. activities table
this.activitiesTable = new dynamodb.Table(this, "ActivitiesTable", {
  tableName: "homeops-activities",
  partitionKey: { name: "chatId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "activityId", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecovery: true,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

// GSI for querying by user and timestamp
this.activitiesTable.addGlobalSecondaryIndex({
  indexName: "userId-timestamp-index",
  partitionKey: { name: "userId", type: dynamodb.AttributeType.NUMBER },
  sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
});

// 2. response_counters table
this.responseCountersTable = new dynamodb.Table(this, "ResponseCountersTable", {
  tableName: "homeops-response-counters",
  partitionKey: { name: "chatId", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "date", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecovery: true,
  timeToLiveAttribute: "ttl", // Auto-cleanup after 7 days
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
```

**Export from MessageStore:**

```typescript
public readonly activitiesTable: dynamodb.Table;
public readonly responseCountersTable: dynamodb.Table;
```

#### Worker Lambda Permission Grants

**In MessageProcessing construct**, grant Worker Lambda permissions:

```typescript
// In the constructor after worker is created:
props.activitiesTable.grant(worker, "dynamodb:PutItem");
props.responseCountersTable.grant(worker, [
  "dynamodb:GetItem",
  "dynamodb:UpdateItem",
]);
props.webhookSecret.grantRead(worker); // Telegram bot token for sendMessage
```

#### Worker Lambda Environment Variables

**Add to MessageProcessing construct:**

```typescript
environment: {
  MESSAGES_TABLE_NAME: props.messagesTable.tableName,
  ACTIVITIES_TABLE_NAME: props.activitiesTable.tableName,
  RESPONSE_COUNTERS_TABLE_NAME: props.responseCountersTable.tableName,
  OPENAI_API_KEY_ARN: props.openaiApiKeySecret.secretArn,
  TELEGRAM_BOT_TOKEN_ARN: props.telegramBotTokenSecret.secretArn,
}
```

#### Timeout & Memory Adjustment

Worker Lambda will now:
- Call OpenAI (network latency ~500-1000ms)
- Call Telegram API (network latency ~300-800ms)
- Perform additional DynamoDB operations

**Recommend increasing timeout from 30s to 60s** and memory from 256 MB to 512 MB (still negligible cost at ~400 invocations/day).

---

## 3. DynamoDB Tables Schema

### Phase 1 Tables (Existing)

#### `homeops-messages`
```
PK: chatId (String)
SK: messageId (Number)

Attributes:
  userId (Number)
  userName (String)
  text (String)
  timestamp (Number) — Unix seconds from Telegram
  raw (String) — Full message JSON from SQS
  createdAt (String) — ISO 8601 when stored
  ttl (Number) — Unix epoch seconds, +90 days for auto-delete
```

**Access Patterns:**
- `Get message by chatId + messageId` (worker for raw message lookup during classification)
- `Query all messages in a chat` (future: for conversation context)
- TTL auto-cleanup runs daily on ~90-day boundary

#### `homeops` (generic)
```
PK: pk (String)
SK: sk (String)
GSI1PK: gsi1pk (String)
GSI1SK: gsi1sk (String)

Reserved for Phase 2+ entities (activities, counters, aliases, preferences, etc.)
```

### Phase 2 Tables (to be created)

#### `homeops-activities`
```
PK: chatId (String)
SK: activityId (String) — ULID for time-ordering + uniqueness

Attributes:
  messageId (Number) — Link back to raw message
  userId (Number)
  userName (String)
  type (String) — "chore" | "recovery"
  activity (String) — Swedish activity name (e.g., "tvätt", "disk")
  effort (String) — "low" | "medium" | "high"
  confidence (Number) — 0.0–1.0
  timestamp (Number) — Unix ms from original message
  createdAt (String) — ISO 8601

GSI: userId-timestamp-index
  PK: userId (Number)
  SK: timestamp (Number)
```

**Access Patterns:**
- `Get activity by chatId + activityId` (activity lookup)
- `Query all activities for a user (index)` — for Phase 3 EMA calculation
- `Query activities in a chat by date range` (future: filtering by date)

**Item Size:** ~300–500 bytes per activity. At 500–2000 activities/month, table stays under 1 MB.

#### `homeops-response-counters`
```
PK: chatId (String)
SK: date (String) — YYYY-MM-DD in Europe/Stockholm timezone

Attributes:
  count (Number) — Response count for this chat on this date
  updatedAt (String) — ISO 8601 of last update
  ttl (Number) — Unix epoch seconds, set to +7 days for auto-cleanup

TTL Attribute: ttl (auto-cleanup after 7 days)
```

**Access Patterns:**
- `Get count by chatId + today's date` (check before sending response)
- `Update count atomic increment` (after sending response)
- Items auto-delete after 7 days via TTL

**Item Size:** ~100 bytes per entry. At ~50 active chats, ~1–2 items/chat/day, negligible storage.

---

## 4. Shared Modules

**Location:** `/Users/martinnordlund/homeOps/src/shared/`

### 4.1 Types

**File:** `/src/shared/types/telegram.ts`

Minimal custom interfaces (no external dependencies):

```typescript
interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
}

interface MessageEntity {
  type: string;
  offset: number;
  length: number;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  entities?: MessageEntity[];
  photo?: unknown[];
  edit_date?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    chat_instance: string;
    data?: string;
  };
}

function isTextMessage(update: TelegramUpdate): boolean {
  return update.message !== undefined && typeof update.message.text === "string";
}
```

**How to extend for Phase 2:**
- Keep minimal custom types for Phase 2
- Add new types for Phase 2: `ClassificationResult`, `TelegramSendMessageRequest`, `OpenAIRequestBody`, `OpenAIResponseBody`
- Consider switching to `@telegraf/types` in Phase 3 when send functionality expands

### 4.2 Utilities

**File:** `/src/shared/utils/secrets.ts`

Provides cached secret retrieval from Secrets Manager:

```typescript
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});

interface CacheEntry {
  value: string;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getSecret(secretArn: string): Promise<string> {
  const cached = cache.get(secretArn);
  if (cached && Date.now() < cached.expiry) {
    return cached.value;
  }

  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  const value = response.SecretString!;
  cache.set(secretArn, { value, expiry: Date.now() + TTL_MS });
  return value;
}
```

**Key Pattern:**
- Client is created at module scope (singleton, reused across Lambda invocations)
- Secrets are cached in-memory for 5 minutes (balances security with cost)
- Used by Ingest Lambda to validate webhook token

**How to use in Phase 2 Worker:**
```typescript
// Import at handler level (after JSON.parse)
const { getSecret } = await import("@shared/utils/secrets.js");
const openaiKey = await getSecret(process.env.OPENAI_API_KEY_ARN!);
const telegramToken = await getSecret(process.env.TELEGRAM_BOT_TOKEN_ARN!);
```

**To add:** Consider creating additional utility modules:
- `dynamodb.ts` — DynamoDB client + helper functions (getItem, putItem, updateItem)
- `openai.ts` — OpenAI API client wrapper for classification
- `telegram.ts` — Telegram sendMessage wrapper

---

## 5. Client Instantiation Patterns

### DynamoDB Client

**Pattern used in Worker Lambda:**

```typescript
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

// In handler:
const command = new PutItemCommand({ ... });
await client.send(command);
```

**Key observations:**
- Client created at module scope (singleton, persisted across warm invocations)
- Uses low-level API (PutItemCommand) with DynamoDB JSON format
- No DocumentClient wrapper

**Recommendation for Phase 2:**
Create shared DynamoDB helper module for reusable operations:

```typescript
// src/shared/utils/dynamodb.ts
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

export async function putItem(
  tableName: string,
  item: Record<string, any>
): Promise<void> {
  const command = new PutItemCommand({ TableName: tableName, Item: item });
  await client.send(command);
}

// ... similar for getItem, updateItem
```

### SQS Client

**Pattern used in Ingest Lambda:**

```typescript
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

let sqs: SQSClient;

export async function handler(event) {
  if (!sqs) {
    sqs = new SQSClient({});
  }
  const command = new SendMessageCommand({ ... });
  await sqs.send(command);
}
```

**Key observations:**
- Lazy initialization pattern: client only created if used
- Stored in outer scope for reuse

---

## 6. Secrets Manager Integration

**Three secrets created by Phase 1 CDK:**

1. **`homeops/telegram-bot-token`**
   - Fetched at runtime by Phase 2 Worker
   - Used for Telegram `sendMessage` API calls
   - Cached for 5 minutes

2. **`homeops/webhook-secret`**
   - Fetched at runtime by Ingest Lambda
   - Validates incoming webhook requests
   - Cached for 5 minutes

3. **`homeops/openai-api-key`**
   - Provisioned in Phase 1 stack (currently unused)
   - Will be fetched by Phase 2 Worker for OpenAI calls
   - Cached for 5 minutes

**Caching Strategy:**
- Provides defense against Secrets Manager API quota limits
- Reduces cost (at ~400 worker invocations/day with 5-min cache, ~1–2 secret fetches/day per key)
- Slight security window during cache TTL (acceptable tradeoff)

---

## 7. SQS Integration

### Queue Configuration (Phase 1)

**Queue Name:** Auto-generated by CDK, passed via `SQS_QUEUE_URL` env var

**Properties:**
- **Type:** Standard (not FIFO)
- **Visibility Timeout:** 180 seconds
- **Message Retention Period:** 4 days (default)
- **DLQ:** Yes, maxReceiveCount = 3, retention = 14 days

### Worker Lambda Event Source Mapping

**Created in MessageProcessing construct:**

```typescript
worker.addEventSource(
  new lambdaEventSources.SqsEventSource(this.queue, {
    batchSize: 1,
    reportBatchItemFailures: true,
  }),
);
```

**Key properties:**
- **Batch size = 1:** Worker processes one message at a time (simpler error handling, avoids batch failures)
- **reportBatchItemFailures = true:** Worker can report individual record failures (not implemented yet, but enabled for future batch processing)

### Failure Handling

**Current behavior:**
- Worker catches `ConditionalCheckFailedException` (duplicate) and silently succeeds
- Other errors throw, triggering SQS retry
- After 3 receive attempts, message moves to DLQ
- CloudWatch alarm fires on DLQ message

**Phase 2 implications:**
- Ingest operation (raw message storage) must succeed before external API calls
- If OpenAI/Telegram calls fail: log error but return success to SQS (don't throw)
- This ensures raw message is persisted even if classification fails

---

## 8. Patterns & Conventions

### TypeScript & ESM

**Configuration Files:**

1. **`tsconfig.json`** (main, for IDE + tests):
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "strict": true,
       "baseUrl": ".",
       "paths": {
         "@shared/*": ["./src/shared/*"]
       }
     },
     "include": ["src/**/*.ts", "test/**/*.ts", "infra/**/*.ts"]
   }
   ```

2. **`tsconfig.cdk.json`** (extends base, for CDK compilation)

**Path Aliases:**
- `@shared/*` resolves to `./src/shared/*`
- Used throughout: `import { getSecret } from "@shared/utils/secrets.js"`
- **Important:** Import paths must include `.js` extension for NodeNext module resolution (ESM)

**Example correct imports:**
```typescript
import type { TelegramUpdate } from "@shared/types/telegram.js";
import { getSecret } from "@shared/utils/secrets.js";
```

### Package Manager

**`package.json` (pnpm workspace):**
- Single root package.json (no workspaces)
- `"type": "module"` for ESM throughout
- All dependencies installed via pnpm (lockfile: `pnpm-lock.yaml`)

### Lambda Handler Bundling

**CDK NodejsFunction configuration (both Ingest & Worker):**

```typescript
const fn = new lambdaNodejs.NodejsFunction(this, "WorkerFn", {
  runtime: lambda.Runtime.NODEJS_22_X,
  architecture: lambda.Architecture.ARM_64,
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
  entry: path.join(__dirname, "../../src/handlers/worker/index.ts"),
  handler: "handler",
  bundling: {
    format: lambdaNodejs.OutputFormat.ESM,
    minify: true,
    sourceMap: true,
  },
  environment: { ... },
});
```

**Key bundling options:**
- **format: ESM** — Uses esbuild with ES modules
- **minify: true** — Reduces bundle size for faster cold starts
- **sourceMap: true** — Inline source maps for debugging
- AWS SDK v3 is automatically bundled and tree-shaken

**Result:** Lambdas deployed as single optimized ESM bundles with source maps, ~300–500ms cold start time.

### Error Handling Conventions

**Worker Lambda pattern:**
```typescript
try {
  await client.send(command);
} catch (error: unknown) {
  if (
    error instanceof Error &&
    error.name === "ConditionalCheckFailedException"
  ) {
    // Idempotent: item already exists, treat as success
    continue;
  }
  throw error; // Let SQS retry
}
```

**Ingest Lambda pattern:**
```typescript
try {
  // ... main logic
  return { statusCode: 200, body: JSON.stringify({}) };
} catch {
  return { statusCode: 500, body: JSON.stringify({ error: "..." }) };
}
```

**For Phase 2:**
- Raw message DynamoDB write: throw on failure (trigger SQS retry)
- OpenAI/Telegram API calls: catch errors, log, continue (don't throw)
- All errors logged to CloudWatch (Lambda automatically sends stdout/stderr)

### Logging

**Current approach:** No explicit logger, rely on CloudWatch Logs
- Lambda captures console output automatically
- 30-day retention per stack

**For Phase 2, consider:**
```typescript
const logger = {
  info: (msg: string, data?: any) => console.log(JSON.stringify({ level: "INFO", msg, data })),
  error: (msg: string, error?: any) => console.error(JSON.stringify({ level: "ERROR", msg, error })),
};
```

---

## 9. Testing Patterns

**Framework:** Vitest v4 with AWS Lambda types

**Key files:**
- `/Users/martinnordlund/homeOps/test/handlers/worker.test.ts` — Worker Lambda tests
- `/Users/martinnordlund/homeOps/test/handlers/ingest.test.ts` — Ingest Lambda tests
- `/Users/martinnordlund/homeOps/test/shared/secrets.test.ts` — Secrets utility tests

### Mock Pattern (Vitest v4)

**Using `vi.hoisted()` for variables referenced in mocks:**

```typescript
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(function () {
    return { send: mockSend };
  }),
  PutItemCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
}));
```

**Important patterns:**
- Use `vi.hoisted()` to declare mocks before `vi.mock()` (prevents TDZ errors)
- Use `function` (not arrow) in `mockImplementation` for constructor calls with `new`
- Reset mocks in `beforeEach`: `mockSend.mockReset()`
- Import actual handler AFTER mock declarations

### Test Structure

**Example: Worker Lambda test**

```typescript
describe("Worker Lambda handler", () => {
  beforeEach(() => {
    process.env.MESSAGES_TABLE_NAME = "test-messages-table";
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  describe("writes message to DynamoDB", () => {
    it("sends PutItemCommand with correct attributes", async () => {
      const handler = await importHandler(); // Dynamic import after mocks
      await handler(makeSqsEvent());

      const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
      expect(PutItemCommand).toHaveBeenCalledWith(
        expect.objectContaining({ TableName: "test-messages-table" })
      );
    });
  });
});
```

### CDK Testing

**Framework:** AWS CDK assertions (Template class)

**Example: MessageStore construct test**

```typescript
describe("MessageStore construct", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    new MessageStore(stack, "TestMessageStore");
    template = Template.fromStack(stack);
  });

  it("creates exactly 2 DynamoDB tables", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 2);
  });

  it("has partition key chatId of type String", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "homeops-messages",
      KeySchema: Match.arrayWith([
        { AttributeName: "chatId", KeyType: "HASH" },
      ]),
    });
  });
});
```

**Key patterns:**
- `Template.fromStack(stack)` captures synthesized CloudFormation
- `resourceCountIs()` verifies resource counts
- `hasResourceProperties()` + `Match.*` for flexible assertions
- No real AWS resources created; all assertions against CloudFormation JSON

---

## 10. Phase 2 Integration Checklist

### CDK Infrastructure Changes

- [ ] Modify `infra/constructs/message-store.ts`:
  - [ ] Create `activitiesTable` (chatId PK, activityId SK, userId-timestamp GSI)
  - [ ] Create `responseCountersTable` (chatId PK, date SK, TTL on `ttl` attr)
  - [ ] Export both as public properties

- [ ] Modify `infra/constructs/message-processing.ts`:
  - [ ] Accept new tables in props
  - [ ] Grant Worker Lambda: `dynamodb:PutItem` on activities + response_counters
  - [ ] Grant Worker Lambda: `dynamodb:GetItem`, `dynamodb:UpdateItem` on response_counters
  - [ ] Grant Worker Lambda: Read on Telegram bot token + OpenAI key secrets
  - [ ] Add env vars: `ACTIVITIES_TABLE_NAME`, `RESPONSE_COUNTERS_TABLE_NAME`, `OPENAI_API_KEY_ARN`, `TELEGRAM_BOT_TOKEN_ARN`
  - [ ] Increase Worker timeout from 30s to 60s
  - [ ] Increase Worker memory from 256 MB to 512 MB (optional, but recommended)

- [ ] Modify `infra/stack.ts`:
  - [ ] Pass new tables from MessageStore to MessageProcessing

- [ ] Add tests for new constructs in `test/infra/message-store.test.ts`

### Shared Modules (New)

- [ ] Create `src/shared/types/openai.ts`:
  - [ ] `ClassificationRequest` interface
  - [ ] `ClassificationResponse` interface with type, activity, effort, confidence

- [ ] Create `src/shared/types/activities.ts`:
  - [ ] `Activity` interface with full schema from PRD

- [ ] Create `src/shared/utils/openai.ts`:
  - [ ] `classifyMessage(text: string, apiKey: string): Promise<ClassificationResponse>`
  - [ ] Handle API errors gracefully

- [ ] Create `src/shared/utils/telegram.ts`:
  - [ ] `sendMessage(chatId: number, text: string, replyToId: number, token: string): Promise<void>`
  - [ ] Handle API errors gracefully

- [ ] Extend `src/shared/utils/dynamodb.ts` (if creating):
  - [ ] Helper functions for activities table operations
  - [ ] Helper functions for response_counters operations

### Worker Lambda Changes

- [ ] Extend `src/handlers/worker/index.ts`:
  - [ ] After successful DynamoDB write, call `classifyMessage()`
  - [ ] If classification succeeds and type is `chore`/`recovery`: write to activities table
  - [ ] Check response_counters before responding
  - [ ] Call Telegram API if response policy allows
  - [ ] Wrap all external API calls in try-catch (log, don't throw)

### Tests

- [ ] Add tests for `src/shared/utils/openai.ts`
- [ ] Add tests for `src/shared/utils/telegram.ts`
- [ ] Update `test/handlers/worker.test.ts`:
  - [ ] Mock OpenAI API calls
  - [ ] Mock Telegram API calls
  - [ ] Mock activities table writes
  - [ ] Verify classification flow
  - [ ] Test error handling for failed API calls

---

## 11. File Path Reference

### Source Code

```
/Users/martinnordlund/homeOps/
├── infra/
│   ├── app.ts                                    # CDK app entry point
│   ├── stack.ts                                  # HomeOpsStack definition
│   ├── config.ts                                 # Configuration (region, stack name)
│   └── constructs/
│       ├── message-store.ts                      # DynamoDB tables (modify for Phase 2)
│       ├── message-processing.ts                 # SQS + Worker Lambda (modify for Phase 2)
│       └── ingestion-api.ts                      # API Gateway + Ingest Lambda
├── src/
│   ├── handlers/
│   │   ├── ingest/
│   │   │   └── index.ts                          # Ingest Lambda handler
│   │   ├── worker/
│   │   │   └── index.ts                          # Worker Lambda handler (modify for Phase 2)
│   │   └── health/
│   │       └── index.ts                          # Health check endpoint
│   └── shared/
│       ├── types/
│       │   └── telegram.ts                       # Telegram API types
│       └── utils/
│           └── secrets.ts                        # Secrets Manager client
├── test/
│   ├── handlers/
│   │   ├── worker.test.ts                        # Worker Lambda tests
│   │   ├── ingest.test.ts                        # Ingest Lambda tests
│   │   └── health.test.ts                        # Health handler tests
│   ├── infra/
│   │   ├── message-processing.test.ts            # MessageProcessing construct tests
│   │   ├── message-store.test.ts                 # MessageStore construct tests
│   │   ├── ingestion-api.test.ts                 # IngestionApi construct tests
│   │   └── stack.test.ts                         # Full stack tests
│   └── shared/
│       └── secrets.test.ts                       # Secrets utility tests
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── tsconfig.cdk.json
├── vitest.config.ts
└── cdk.json
```

### Documentation

```
/Users/martinnordlund/homeOps/docs/
└── features/
    ├── homeops-p1-infra/
    │   ├── prd.md                                # Phase 1 PRD
    │   ├── research/
    │   │   ├── SUMMARY.md                        # Phase 1 research synthesis
    │   │   ├── telegram-webhook.md
    │   │   ├── sqs-configuration.md
    │   │   ├── dynamodb-design.md
    │   │   └── cdk-patterns.md
    │   └── verify/                               # Phase 1 verification docs
    └── homeops-p2-classification/
        ├── prd.md                                # Phase 2 PRD
        └── scope-brief.md
```

---

## 12. Key Integration Points Summary

### Worker Lambda Will Now:

1. **Receive SQS message** (unchanged) — chatId, messageId, userId, userName, text, timestamp

2. **Write to messages table** (unchanged) — store raw message with TTL

3. **Classify message** (NEW) — call OpenAI Chat Completions API
   - Input: message text (+ optional context from raw message)
   - Output: type (chore|recovery|none), activity name, effort, confidence
   - Error: log, continue (don't retry via SQS)

4. **Store activity** (NEW) — if classification succeeds and type is chore/recovery
   - Write to activities table with ULID sort key
   - Include messageId link back to raw message

5. **Check response policy** (NEW) — if activity detected
   - Query response_counters for today's date
   - Check confidence, quiet hours, daily cap, conversation pace
   - Decide whether to respond

6. **Send Telegram response** (NEW) — if policy allows
   - Call Telegram Bot API with sendMessage
   - Reply to original message with reply_to_message_id
   - Update response_counters counter
   - Error: log, continue (don't fail the message)

### DynamoDB Will Now Have:

1. **homeops-messages** — raw messages (unchanged)
2. **homeops** — single-table-design placeholder (from Phase 1)
3. **homeops-activities** — classified activities (NEW)
4. **homeops-response-counters** — daily response tracking (NEW)

### Secrets Manager Will Now Be Used For:

1. **homeops/webhook-secret** — (Ingest Lambda, existing)
2. **homeops/telegram-bot-token** — (Worker Lambda, NEW for Telegram API calls)
3. **homeops/openai-api-key** — (Worker Lambda, NEW for OpenAI API calls)

---

## 13. Performance & Cost Implications

### Estimated Cold Start Impact

- **Phase 1 Worker cold start:** ~400–575ms
- **Phase 2 Worker cold start:** +100–200ms (additional SDK bundle for OpenAI/Telegram)
- **Secrets fetch:** Cached at 5-min TTL (net ~1–2 per day per secret)
- **Still well under 2-second target**

### Estimated Cost Impact (At ~200 messages/day)

- **DynamoDB on-demand:**
  - messages table: ~0.001/month (unchanged)
  - activities table: ~0.002/month (new, ~6K writes/month)
  - response_counters table: ~0.001/month (new, negligible)
  - **Total:** ~$0.004/month (negligible increase)

- **OpenAI API:**
  - ~200 calls/day = ~6K calls/month
  - Input: ~50–100 tokens per message
  - Output: ~20–50 tokens per response
  - Est. cost: ~$0.02–0.05/month (at current pricing)

- **Telegram Bot API:**
  - ~20–50 responses/day = ~600–1500 calls/month
  - No per-call charge, rate limits only
  - Cost: $0

- **Lambda:** Unchanged (still within free tier)

- **SQS:** Unchanged (still within free tier)

**Total Phase 2 recurring cost: ~$0.03–0.10/month** (dominated by OpenAI)

---

## 14. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| OpenAI API timeout blocks message processing | Medium | Medium | Set 5s timeout on OpenAI calls; if timeout, log and continue |
| OpenAI quota exhausted | Low | High | Monitor API usage via OpenAI dashboard; implement fallback silence policy |
| Telegram API rate limits hit | Low | Low | Batch responses, spread sends over time if needed |
| Classification fails but returns error instead of result | Medium | Medium | Validate OpenAI response structure; log unexpected formats |
| DynamoDB writes (activities) fail silently | Low | Medium | Wrap in try-catch; log failures; CloudWatch alarm on errors |
| Daily response counter becomes inconsistent (concurrent writes) | Low | Low | Use DynamoDB atomic UpdateItem with ADD; eventual consistency acceptable |
| Timezone calculation wrong for response_counters date | Medium | Low | Use `date-fns` or `luxon` with explicit Stockholm timezone; test thoroughly |
| Worker Lambda timeout increased to 60s but invocations are slow | Low | Low | Monitor Lambda duration in CloudWatch; adjust if most invocations exceed 30s |

---

## Conclusion

Phase 1 establishes a minimal but robust foundation: Telegram → API Gateway → SQS → DynamoDB. The Worker Lambda will be extended in Phase 2 to add classification and response logic, reusing all Phase 1 infrastructure and patterns. The integration is well-designed: raw message storage is idempotent and happens first (before external APIs), ensuring data loss is nearly impossible. External API failures are handled gracefully without blocking the pipeline.

All code adheres to established patterns: ESM modules with `@shared/*` aliases, Vitest mocks with `vi.hoisted()`, DynamoDB low-level API with conditional writes, and lazy-initialized AWS SDK clients. The monorepo structure (single package.json, `/infra`, `/src`, `/test` directories) is clean and extensible.

---

**Document prepared:** 2026-02-17
**Codebase snapshot:** HomeOps commit [current state]
**Next phase:** Phase 2 implementation following this analysis
