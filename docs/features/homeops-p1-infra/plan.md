# Technical Plan: Infrastructure & Telegram Ingestion

**Feature:** homeops-p1-infra
**PRD:** `/docs/features/homeops-p1-infra/prd.md`
**Research:** `/docs/features/homeops-p1-infra/research/SUMMARY.md`

---

## Decisions Log

| # | Choice | Alternative | Reason |
|---|--------|-------------|--------|
| 1 | pnpm | npm, bun | User preference |
| 2 | eslint + prettier | biome | User preference |
| 3 | Vitest | Jest | Research resolved decision — native TS, fast, CDK-compatible |
| 4 | `tsx` for CDK app runner | `ts-node` | Research resolved decision — better ESM handling |
| 5 | HTTP API (not REST API) | REST API | Research — 71% cheaper, lower latency, simpler payload |
| 6 | Standard SQS (not FIFO) | FIFO | Research — ordering irrelevant, app-level dedup via DynamoDB |
| 7 | DynamoDB on-demand billing | Provisioned | Research — eliminates throttling risk, ~$0.01/mo |
| 8 | Node.js 22 ARM64 (Graviton) | Node.js 20 x86 | Research — Node 20 EOL April 2026, ARM cheaper |
| 9 | Custom Telegram types | `@telegraf/types` | Research — 5 interfaces, zero deps, switch Phase 2 |
| 10 | Hybrid DynamoDB (messages + empty homeops table) | Single-table only | Research resolved — costs nothing, ready for Phase 2 |
| 11 | 90-day TTL on raw messages | No TTL | Research resolved decision |
| 12 | `@shared/...` path aliases | Relative imports | Research resolved decision |
| 13 | Secret token validation only | IP allowlisting | Research resolved — sufficient security |
| 14 | CloudWatch console only for alarms | SNS/email | Research resolved decision |
| 15 | Flat monorepo, single package.json | Workspaces | Research — fewer than 50 resources, tightly coupled |
| 16 | Monorepo at repo root | Subdirectory | Decision — repo is empty, no need for nesting |
| 17 | ESM Lambda bundles (minified, source maps) | CJS | Research — tree-shaking, faster cold starts |
| 18 | 3 CDK grouping constructs | Nested stacks | Research — single stack, simple `cdk deploy/destroy` |

---

## DB Changes

### `homeops-messages` table

| Attribute | Type   | Key  | Notes |
|-----------|--------|------|-------|
| chatId    | String | PK   | String representation of Telegram chat.id |
| messageId | Number | SK   | Telegram message_id, monotonically increasing |
| userId    | Number |      | Telegram user.id |
| userName  | String |      | Telegram user.first_name |
| text      | String |      | Message text content |
| timestamp | Number |      | Unix epoch milliseconds |
| raw       | String |      | Full Telegram Update JSON |
| createdAt | String |      | ISO 8601 |
| ttl       | Number |      | Unix epoch seconds, createdAt + 90 days |

- On-demand billing, no GSIs
- Point-in-time recovery enabled
- TTL enabled on `ttl` attribute

### `homeops` table (empty, created for Phase 2)

| Attribute | Type   | Key  |
|-----------|--------|------|
| pk        | String | PK   |
| sk        | String | SK   |
| gsi1pk    | String | GSI1 PK |
| gsi1sk    | String | GSI1 SK |

- On-demand billing
- One GSI (`gsi1`): `gsi1pk` (PK), `gsi1sk` (SK)
- Point-in-time recovery enabled

---

## API Contracts

### POST /webhook (Telegram updates)

**Request:** Telegram Update JSON (from Telegram Bot API)
**Headers:** `x-telegram-bot-api-secret-token: <secret>`

**Response:**
- `200 {}` — accepted (always, even for skipped updates)
- `401 { "error": "Unauthorized" }` — invalid/missing secret token
- `500 { "error": "Internal server error" }` — SQS enqueue failure (triggers Telegram retry)

**Behavior:**
- Validate secret token header
- Parse Update, extract `message` field
- Skip non-text-message updates (return 200)
- Enqueue message to SQS
- Return 200 immediately

### GET /health

**Response:**
```json
{
  "status": "ok",
  "version": "<deploy-version>"
}
```

- Always returns `200`

---

## Project Structure

```
/
├── infra/
│   ├── app.ts                     # CDK app entry point
│   ├── stack.ts                   # Main HomeOps stack
│   ├── constructs/
│   │   ├── ingestion-api.ts       # API Gateway + Ingest Lambda
│   │   ├── message-processing.ts  # SQS + Worker Lambda
│   │   └── message-store.ts       # DynamoDB tables
│   └── config.ts                  # Stack config (region, table names, etc.)
├── src/
│   ├── handlers/
│   │   ├── ingest/
│   │   │   └── index.ts           # Ingest Lambda handler
│   │   ├── worker/
│   │   │   └── index.ts           # Worker Lambda handler
│   │   └── health/
│   │       └── index.ts           # Health check handler
│   └── shared/
│       ├── types/
│       │   └── telegram.ts        # Minimal Telegram types
│       └── utils/
│           └── secrets.ts         # Secrets Manager fetch + cache
├── test/
│   ├── infra/
│   │   └── stack.test.ts          # CDK assertion tests
│   ├── handlers/
│   │   ├── ingest.test.ts
│   │   ├── worker.test.ts
│   │   └── health.test.ts
│   └── shared/
│       └── secrets.test.ts
├── scripts/
│   └── register-webhook.sh        # Telegram webhook registration
├── package.json
├── tsconfig.json                   # Base (IDE + esbuild)
├── tsconfig.cdk.json               # CDK compilation (extends base)
├── vitest.config.ts
├── .eslintrc.cjs
├── .prettierrc
├── cdk.json
└── .gitignore
```

---

## Implementation Tasks

### Task 1-test: Project scaffolding validation tests

- **Type:** test
- **Files:** `test/setup.test.ts`
- **Dependencies:** none
- **Description:** Write tests that verify: (1) `tsconfig.json` compiles without errors, (2) path alias `@shared/types/telegram` resolves, (3) vitest runs successfully. These are smoke tests to validate the project structure.

### Task 1a-impl: Project init and dependencies

- **Type:** impl
- **Files:** `package.json`, `.gitignore`, `.npmrc`
- **Dependencies:** Task 1-test
- **Description:** Run `pnpm init`. Install dependencies: `aws-cdk-lib`, `constructs`, `@aws-sdk/client-dynamodb`, `@aws-sdk/client-sqs`, `@aws-sdk/client-secrets-manager`, `esbuild`, `tsx`, `typescript`, `vitest`, `eslint`, `prettier`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `aws-cdk`. Create `.gitignore` (node_modules, cdk.out, *.js in infra/, .env). Create `.npmrc` if needed for pnpm settings.

### Task 1b-impl: Project config files

- **Type:** impl
- **Files:** `tsconfig.json`, `tsconfig.cdk.json`, `vitest.config.ts`, `.eslintrc.cjs`, `.prettierrc`, `cdk.json`
- **Dependencies:** Task 1a-impl
- **Description:** Create: (1) `tsconfig.json` — base config with `@shared/*` path aliases mapping to `src/shared/*`, strict mode, ESM module resolution. (2) `tsconfig.cdk.json` — extends base, includes `infra/**/*.ts`. (3) `vitest.config.ts` — resolve `@shared` alias, include `test/**/*.test.ts`. (4) `.eslintrc.cjs` + `.prettierrc` — standard TypeScript config. (5) `cdk.json` — app command using `tsx`, context settings. Read tests at `test/setup.test.ts` — your goal is to make them pass.

### Task 2-test: Telegram types and shared utils tests

- **Type:** test
- **Files:** `test/shared/telegram-types.test.ts`, `test/shared/secrets.test.ts`
- **Dependencies:** Task 1b-impl
- **Description:** Write tests for: (1) Telegram type guards — `isTextMessage(update)` returns true for valid text message updates, false for edited messages, callbacks, empty updates, and updates without text. (2) Secrets utility — `getSecret(secretArn)` calls SecretsManager `GetSecretValue`, caches the result, returns cached value on subsequent calls within TTL, re-fetches after TTL expires. Mock `@aws-sdk/client-secrets-manager`.

### Task 2-impl: Telegram types and shared utils

- **Type:** impl
- **Files:** `src/shared/types/telegram.ts`, `src/shared/utils/secrets.ts`
- **Dependencies:** Task 2-test
- **Description:** Implement: (1) Minimal Telegram types — `TelegramUpdate`, `TelegramMessage`, `TelegramUser`, `TelegramChat`, `MessageEntity` interfaces plus `isTextMessage` type guard. (2) Secrets utility — `getSecret(secretArn)` with module-scope cache (5-minute TTL), using `@aws-sdk/client-secrets-manager`. Read tests first — make them pass.

### Task 3-test: Ingest Lambda handler tests

- **Type:** test
- **Files:** `test/handlers/ingest.test.ts`
- **Dependencies:** Task 2-impl
- **Description:** Write tests for the Ingest Lambda: (1) Returns 401 when `x-telegram-bot-api-secret-token` header is missing or invalid. (2) Returns 200 and enqueues to SQS for valid text message update. (3) Returns 200 and does NOT enqueue for non-text updates (edited message, callback query, no message field). (4) Returns 500 when SQS `SendMessage` fails. (5) SQS message body contains the extracted message fields. Mock `@aws-sdk/client-sqs` and the secrets utility. Use API Gateway HTTP API payload format 2.0 event structure.

### Task 3-impl: Ingest Lambda handler

- **Type:** impl
- **Files:** `src/handlers/ingest/index.ts`
- **Dependencies:** Task 3-test
- **Description:** Implement the Ingest Lambda handler. Receives API Gateway HTTP API v2 event. Validates `x-telegram-bot-api-secret-token` header against secret from Secrets Manager. Parses body as Telegram Update. Uses `isTextMessage` to filter. Enqueues valid messages to SQS (queue URL from env var `SQS_QUEUE_URL`). Returns 200 for all valid requests, 401 for bad token, 500 for SQS failure. Structured JSON logging for all operations. Read tests first — make them pass.

### Task 4-test: Worker Lambda handler tests

- **Type:** test
- **Files:** `test/handlers/worker.test.ts`
- **Dependencies:** Task 2-impl
- **Description:** Write tests for the Worker Lambda: (1) Writes message to DynamoDB with correct attributes (chatId, messageId, userId, userName, text, timestamp, raw, createdAt, ttl). (2) Idempotent — catches `ConditionalCheckFailedException` and treats as success (no throw). (3) Throws on other DynamoDB errors (so SQS retries). (4) Correctly computes `ttl` as createdAt + 90 days in Unix epoch seconds. (5) Processes SQS event record body correctly. Mock `@aws-sdk/client-dynamodb`.

### Task 4-impl: Worker Lambda handler

- **Type:** impl
- **Files:** `src/handlers/worker/index.ts`
- **Dependencies:** Task 4-test
- **Description:** Implement the Worker Lambda handler. Triggered by SQS event. Parses message body. Performs conditional `PutItem` to DynamoDB (`attribute_not_exists(chatId) AND attribute_not_exists(messageId)`). Sets `ttl` attribute (createdAt + 90 days as Unix epoch seconds). Catches `ConditionalCheckFailedException` as success. Table name from env var `MESSAGES_TABLE_NAME`. Structured JSON logging. Read tests first — make them pass.

### Task 5-test: Health check handler tests

- **Type:** test
- **Files:** `test/handlers/health.test.ts`
- **Dependencies:** Task 1b-impl
- **Description:** Write tests for the health endpoint: (1) Returns 200 with `{ "status": "ok", "version": "<version>" }`. (2) Version comes from env var `DEPLOY_VERSION`. (3) Returns `"unknown"` as version if env var is not set. (4) Response has `content-type: application/json` header.

### Task 5-impl: Health check handler

- **Type:** impl
- **Files:** `src/handlers/health/index.ts`
- **Dependencies:** Task 5-test
- **Description:** Implement the health check Lambda handler. Returns 200 with JSON body `{ "status": "ok", "version": process.env.DEPLOY_VERSION || "unknown" }`. Structured JSON logging. Read tests first — make them pass.

### Task 6-test: CDK MessageStore construct tests

- **Type:** test
- **Files:** `test/infra/message-store.test.ts`
- **Dependencies:** Task 1b-impl
- **Description:** Write CDK assertion tests for the MessageStore construct: (1) Creates `homeops-messages` DynamoDB table with `chatId` (S) as PK, `messageId` (N) as SK, on-demand billing, PITR enabled, TTL on `ttl` attribute. (2) Creates `homeops` DynamoDB table with `pk` (S) as PK, `sk` (S) as SK, on-demand billing, PITR enabled, one GSI (`gsi1`) with `gsi1pk` (PK) and `gsi1sk` (SK). (3) Both tables have `RemovalPolicy.DESTROY`. Use `@aws-cdk/assertions` `Template.fromStack()`.

### Task 6-impl: CDK MessageStore construct

- **Type:** impl
- **Files:** `infra/constructs/message-store.ts`
- **Dependencies:** Task 6-test
- **Description:** Implement the MessageStore CDK construct. Creates two DynamoDB tables: `homeops-messages` (chatId PK, messageId SK, on-demand, PITR, TTL on `ttl`, RemovalPolicy.DESTROY) and `homeops` (pk/sk PK/SK, on-demand, PITR, GSI `gsi1` with gsi1pk/gsi1sk, RemovalPolicy.DESTROY). Export table references for use by other constructs. Read tests first — make them pass.

### Task 7-test: CDK MessageProcessing construct tests

- **Type:** test
- **Files:** `test/infra/message-processing.test.ts`
- **Dependencies:** Task 1b-impl
- **Description:** Write CDK assertion tests for the MessageProcessing construct: (1) Creates SQS queue with visibility timeout 180s. (2) Creates DLQ with 14-day retention. (3) Main queue has `maxReceiveCount: 3` redrive policy to DLQ. (4) Creates Worker Lambda (Node.js 22, ARM64, 30s timeout, 256MB memory). (5) Worker Lambda has SQS event source mapping with batch size 1 and `reportBatchItemFailures` enabled. (6) Worker Lambda has env vars `MESSAGES_TABLE_NAME`. (7) Worker Lambda IAM role has DynamoDB `PutItem` permission scoped to messages table. (8) CloudWatch alarm on DLQ `ApproximateNumberOfMessagesVisible > 0`. (9) CloudWatch alarm on Lambda error rate > 5% (errors / invocations).

### Task 7-impl: CDK MessageProcessing construct

- **Type:** impl
- **Files:** `infra/constructs/message-processing.ts`
- **Dependencies:** Task 7-test, Task 6-impl
- **Description:** Implement the MessageProcessing CDK construct. Creates: Standard SQS queue (180s visibility timeout), DLQ (14-day retention, maxReceiveCount 3), Worker Lambda (NodejsFunction, Node.js 22, ARM64, 30s timeout, 256MB, ESM bundling, env vars for table name), SQS event source mapping (batch size 1, reportBatchItemFailures), CloudWatch alarm on DLQ depth > 0, CloudWatch alarm on Lambda error rate > 5%. Grant Worker Lambda `PutItem` on messages table. Accept messages table as construct prop. Read tests first — make them pass.

### Task 8-test: CDK IngestionApi construct tests

- **Type:** test
- **Files:** `test/infra/ingestion-api.test.ts`
- **Dependencies:** Task 1b-impl
- **Description:** Write CDK assertion tests for the IngestionApi construct: (1) Creates HTTP API (API Gateway v2). (2) Creates Ingest Lambda (Node.js 22, ARM64, 10s timeout, 256MB). (3) POST /webhook route integrated with Ingest Lambda. (4) GET /health route integrated with Health Lambda. (5) Ingest Lambda has env vars `SQS_QUEUE_URL` and `WEBHOOK_SECRET_ARN`. (6) Ingest Lambda has IAM permissions for SQS `SendMessage` (scoped to queue) and Secrets Manager `GetSecretValue` (scoped to secret). (7) Health Lambda has env var `DEPLOY_VERSION`.

### Task 8-impl: CDK IngestionApi construct

- **Type:** impl
- **Files:** `infra/constructs/ingestion-api.ts`
- **Dependencies:** Task 8-test, Task 7-impl
- **Description:** Implement the IngestionApi CDK construct. Creates: HTTP API (ApiGatewayV2), Ingest Lambda (NodejsFunction, Node.js 22, ARM64, 10s timeout, 256MB, ESM bundling, env vars for queue URL and secret ARN), Health Lambda (same config, env var DEPLOY_VERSION), POST /webhook route, GET /health route. Grant Ingest Lambda SQS SendMessage and SecretsManager GetSecretValue. Accept queue and secret as construct props. Read tests first — make them pass.

### Task 9-test: CDK Stack integration tests

- **Type:** test
- **Files:** `test/infra/stack.test.ts`
- **Dependencies:** Task 6-impl, Task 7-impl, Task 8-impl
- **Description:** Write CDK assertion tests for the full HomeOps stack: (1) Stack synthesizes without errors. (2) Contains all expected resources: 2 DynamoDB tables, 1 SQS queue, 1 DLQ, 3 Lambda functions, 1 HTTP API, 2 CloudWatch alarms. (3) Secrets Manager secrets exist for: bot token, webhook secret token, and OpenAI API key. (4) Stack is in eu-north-1. (5) All Lambda log groups have 30-day retention.

### Task 9-impl: CDK Stack, app entry point, and config

- **Type:** impl
- **Files:** `infra/stack.ts`, `infra/app.ts`, `infra/config.ts`
- **Dependencies:** Task 9-test, Task 8-impl
- **Description:** Implement: (1) `config.ts` — stack config constants (region `eu-north-1`, table names, log retention). (2) `stack.ts` — main stack composing MessageStore, MessageProcessing, IngestionApi constructs. Creates Secrets Manager secrets for bot token, webhook secret token, and OpenAI API key (stored now, used Phase 2). Wires construct dependencies (passes table refs, queue, secret to child constructs). Sets 30-day log retention on all Lambda log groups. (3) `app.ts` — CDK app entry point, instantiates stack. Read tests first — make them pass.

### Task 10-test: Webhook registration script tests

- **Type:** test
- **Files:** `test/scripts/register-webhook.test.sh`
- **Dependencies:** none
- **Description:** Write a shell test script that validates the webhook registration script: (1) Exits with error if no API Gateway URL argument is provided. (2) Exits with error if `aws` CLI is not available. (3) Prints usage instructions with `--help` flag. Use basic shell assertions (exit codes and stdout checks). This is a lightweight validation — the actual Telegram API call is not testable without credentials.

### Task 10-impl: Webhook registration script

- **Type:** impl
- **Files:** `scripts/register-webhook.sh`
- **Dependencies:** Task 10-test
- **Description:** Create a shell script that registers the Telegram webhook. Reads bot token and webhook secret from AWS Secrets Manager (using `aws secretsmanager get-secret-value`). Calls Telegram `setWebhook` API with: `url` (API Gateway endpoint, passed as argument), `secret_token` (from Secrets Manager), `allowed_updates: ["message"]`, `drop_pending_updates: true`, `max_connections: 10`. Prints success/failure. Includes usage instructions in comments. Validates arguments and dependencies before making API calls.

---

## Execution Waves

```
Wave 1:  Task 1-test, Task 10-test
Wave 2:  Task 1a-impl
Wave 3:  Task 1b-impl
Wave 4:  Task 2-test, Task 5-test, Task 6-test, Task 7-test, Task 8-test, Task 10-impl
Wave 5:  Task 2-impl, Task 5-impl, Task 6-impl
Wave 6:  Task 3-test, Task 4-test, Task 7-impl, Task 8-impl
Wave 7:  Task 3-impl, Task 4-impl, Task 9-test
Wave 8:  Task 9-impl
```

---

## Post-Deploy Manual Verification

These PRD success criteria require a deployed stack and cannot be validated via unit tests:

- [ ] End-to-end latency (webhook to DB write) < 2s — measure by sending a test message and checking DynamoDB timestamp
- [ ] `cdk deploy` succeeds and creates all resources in eu-north-1
- [ ] `cdk destroy` cleanly removes all resources
- [ ] Sending a message in Telegram group results in a raw message record in DynamoDB

---

## Context Budget Check

- [x] No task touches more than 5 files (max is 6 config files in Task 1b-impl — acceptable for pure config)
- [x] Each task description is under 20 lines
- [x] Each task can be understood without reading the full plan
- [x] Dependencies are explicit — no implicit ordering
- [x] Every impl task depends on its corresponding test task
- [x] No test task depends on its own impl task

## Scope Note

The `homeops` table (empty, for Phase 2) is included per research resolved decision #8: "Create in Phase 1. Costs nothing, validates CDK code, ready for Phase 2." It is not in the PRD's explicit scope but was approved during research review.
