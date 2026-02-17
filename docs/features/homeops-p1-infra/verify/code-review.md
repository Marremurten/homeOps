# Code Review: homeops-p1-infra

**Reviewer:** code-reviewer
**Date:** 2026-02-17
**Overall Assessment:** Ship with fixes

---

## Summary

The implementation is well-structured, follows the plan decisions closely, and covers all PRD in-scope items. Code is clean, types are specific, and test coverage is meaningful. There are a handful of issues to address — two blocking (missing structured logging, missing ESM bundling on ingest/health lambdas) and several suggestions.

---

## Blocking Issues

### B1. No structured JSON logging in any Lambda handler

**PRD requirement:** "Structured logging (JSON) for all operations" (Section 5, Worker Lambda) and "CloudWatch logs capture structured JSON for all Lambda invocations" (Success Criteria).

**Affected files:**
- `/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts` — no logging at all
- `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts` — no logging at all
- `/Users/martinnordlund/homeOps/src/handlers/health/index.ts` — no logging at all

None of the three handlers contain any `console.log`, `console.info`, or structured logging calls. The PRD explicitly requires structured JSON logging for all Lambda invocations. At minimum, each handler should log: the event received (or a summary), the action taken (enqueued, wrote to DDB, skipped), and any errors.

### B2. Missing ESM bundling configuration on Ingest and Health Lambdas

**Affected file:** `/Users/martinnordlund/homeOps/infra/constructs/ingestion-api.ts`

The Worker Lambda in `message-processing.ts:43-47` correctly specifies ESM bundling:
```ts
bundling: {
  format: lambdaNodejs.OutputFormat.ESM,
  minify: true,
  sourceMap: true,
},
```

But neither the Ingest Lambda (line 27-38) nor the Health Lambda (line 40-50) in `ingestion-api.ts` have a `bundling` block. Per plan decision #17 ("ESM Lambda bundles, minified, source maps"), all Lambdas should use ESM bundling. Without this, the Ingest Lambda's `import()` of `@shared/utils/secrets.js` may fail at runtime since the path alias won't be resolved in the bundled output, and the handlers will produce larger, non-tree-shaken bundles.

### B3. Worker Lambda does not return `batchItemFailures` response

**Affected file:** `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts:15`

The SQS event source mapping is configured with `reportBatchItemFailures: true` (`message-processing.ts:55`), but the handler signature returns `Promise<void>` and never returns a `{ batchItemFailures: [...] }` response. When `reportBatchItemFailures` is enabled, the Lambda must return `SQSBatchResponse` indicating which items failed; otherwise, SQS treats all items as failed on any error or treats all as successful on void return. With `batchSize: 1` this is currently benign, but it's technically incorrect and will break silently when batch size is increased in the future.

---

## Non-Blocking Issues

### N1. `chatId` type mismatch between Ingest and Worker

**Files:**
- `/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts:40` — `chatId: message.chat.id` (type `number` from `TelegramChat.id`)
- `/Users/martinnordlund/homeOps/src/handlers/worker/index.ts:7` — `chatId: string` in `MessageBody` interface

The Ingest handler sends `chatId` as a number (Telegram chat.id is a number). The Worker interface declares it as `string`. `JSON.parse` will produce a number, and `String(body.chatId)` on line 26 coerces it to a string for DynamoDB. This works at runtime but the TypeScript type is misleading. Either the Worker interface should declare `chatId: number` (matching reality) or the Ingest handler should explicitly convert it to a string before sending.

### N2. Non-null assertion on `response.SecretString`

**File:** `/Users/martinnordlund/homeOps/src/shared/utils/secrets.ts:27`

```ts
const value = response.SecretString!;
```

`SecretString` can be `undefined` if the secret is stored as binary. A guard or explicit error would be safer:
```ts
if (!response.SecretString) throw new Error(`Secret ${secretArn} has no string value`);
```

### N3. Non-null assertions on `message.from` in Ingest handler

**File:** `/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts:37`

```ts
const from = message.from!;
```

`from` is optional in the Telegram API (e.g., channel posts have no `from`). Since `isTextMessage` only checks for `message` and `text` existence, a channel post with text would pass the guard but `from` would be undefined. The type guard should also verify `message.from` exists, or the handler should guard against it.

### N4. `openaiApiKeySecret` declared but never used

**File:** `/Users/martinnordlund/homeOps/infra/stack.ts:24-30`

The variable `openaiApiKeySecret` is assigned but never referenced. The secret is still created (which is correct per PRD), but the unused variable will trigger ESLint's `no-unused-vars` rule. Prefix with `_` or remove the variable assignment and just call `new secretsmanager.Secret(...)` without storing the result.

### N5. Config constants defined but not used

**File:** `/Users/martinnordlund/homeOps/infra/config.ts`

`config.messagesTableName`, `config.homeopsTableName`, and `config.logRetentionDays` are defined but never imported or used anywhere. Table names are hardcoded in `message-store.ts` ("homeops-messages", "homeops") and log retention is hardcoded as `30` in `stack.ts:49`. Either use the config constants or remove them to avoid confusion.

### N6. Worker errors alarm does not match PRD specification

**PRD requirement:** "Lambda error rate > 5%" (Section 8, Reliability).
**Plan requirement:** "CloudWatch alarm on Lambda error rate > 5%" (Task 7).

**File:** `/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts:70-76`

The current alarm fires on `metricErrors() > 0`, which means it alarms on any single error, not on a 5% error rate. A proper rate alarm would use a math expression: `errors / invocations > 0.05`. The test at `/Users/martinnordlund/homeOps/test/infra/message-processing.test.ts:119-124` only checks `MetricName: "Errors"` with `GreaterThanThreshold`, which matches the implementation but not the spec. This is a deviation from both the PRD and plan.

### N7. Webhook secret name mismatch between CDK and registration script

**Files:**
- `/Users/martinnordlund/homeOps/infra/stack.ts:17` — secret name `homeops/telegram-bot-token`
- `/Users/martinnordlund/homeOps/infra/stack.ts:20` — secret name `homeops/webhook-secret`
- `/Users/martinnordlund/homeOps/scripts/register-webhook.sh:27` — default `homeops/telegram/bot-token`
- `/Users/martinnordlund/homeOps/scripts/register-webhook.sh:28` — default `homeops/telegram/webhook-secret`

The CDK stack creates secrets with names `homeops/telegram-bot-token` and `homeops/webhook-secret`, but the shell script defaults to `homeops/telegram/bot-token` and `homeops/telegram/webhook-secret` (extra `/telegram/` segment in bot token, different path for webhook secret). The script will fail at runtime unless the environment variables are explicitly overridden.

### N8. `timestamp` in Ingest handler uses Telegram `date` (seconds) but PRD says "Unix ms"

**Files:**
- `/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts:45` — `timestamp: message.date`
- PRD DynamoDB Table Design: `timestamp | Number | (Unix ms)`

Telegram's `message.date` is Unix epoch in **seconds**. The PRD specifies the `timestamp` attribute should be "Unix ms". The ingest handler passes the raw seconds value without converting to milliseconds.

---

## Pattern Compliance

| Criterion | Status | Notes |
|-----------|--------|-------|
| ESM (`"type": "module"` in package.json) | Pass | |
| pnpm as package manager | Pass | `packageManager` field set |
| TypeScript strict mode | Pass | `strict: true` in tsconfig.json |
| `@shared/*` path aliases with `.js` extension | Pass | Used correctly in imports |
| Node.js 22 ARM64 | Pass | All Lambdas use `NODEJS_22_X` + `ARM_64` |
| HTTP API (not REST API) | Pass | Uses `HttpApi` from apigatewayv2 |
| Standard SQS (not FIFO) | Pass | |
| DynamoDB on-demand billing | Pass | `PAY_PER_REQUEST` on both tables |
| Vitest (not Jest) | Pass | |
| `tsx` for CDK app runner | Pass | `cdk.json` uses `npx tsx infra/app.ts` |
| `vi.hoisted()` for mock variables | Pass | All test files use this pattern correctly |
| `function` keyword in `mockImplementation` | Pass | Consistent across all mock factories |
| 3 CDK grouping constructs | Pass | MessageStore, MessageProcessing, IngestionApi |
| Flat monorepo, single package.json | Pass | |
| Custom Telegram types (no deps) | Pass | 5 interfaces + type guard in `telegram.ts` |
| 90-day TTL on raw messages | Pass | TTL computation correct in worker |
| Hybrid DynamoDB (messages + homeops table) | Pass | Both tables created |
| Secret token validation | Pass | Ingest handler validates header |
| `vi.clearAllMocks()` in `beforeEach` | Partial | Used in ingest test; worker test uses `mockSend.mockReset()` directly |

---

## Scope Compliance (PRD vs Implementation)

### All in-scope items implemented:

- [x] Project setup (monorepo structure, TS, pnpm, linting, tsconfig)
- [x] Telegram bot token and webhook secret in Secrets Manager
- [x] Webhook registration script
- [x] CDK Stack in eu-north-1
- [x] API Gateway HTTP API with POST /webhook and GET /health
- [x] Ingest Lambda (validate, filter, enqueue)
- [x] SQS Queue with DLQ (maxReceiveCount: 3)
- [x] Worker Lambda (dequeue, conditional write to DynamoDB)
- [x] DynamoDB messages table (chatId PK, messageId SK, TTL)
- [x] DynamoDB homeops table (pk/sk, GSI)
- [x] OpenAI API key secret (stored for Phase 2)
- [x] Health check endpoint
- [x] IAM least-privilege (grants scoped to specific resources)
- [x] CloudWatch alarms (DLQ depth, Lambda errors)
- [x] CloudWatch log groups with 30-day retention
- [x] RemovalPolicy.DESTROY on all resources

### Scope creep: None detected

All implementation matches PRD requirements. No extra features, endpoints, or resources beyond what was specified.

---

## Test Quality Assessment

| Test File | Assessment |
|-----------|-----------|
| `test/setup.test.ts` | Good — validates project scaffolding, path alias resolution |
| `test/shared/telegram-types.test.ts` | Good — covers valid text, edited, callback, empty, photo-without-text |
| `test/shared/secrets.test.ts` | Good — covers fetch, cache, TTL expiry, error propagation; uses `vi.useFakeTimers()` correctly |
| `test/handlers/ingest.test.ts` | Good — covers auth (missing/wrong token), valid enqueue, non-text updates, SQS failure; checks message body fields |
| `test/handlers/worker.test.ts` | Good — checks each DynamoDB attribute individually, TTL computation, idempotency, error re-throw |
| `test/handlers/health.test.ts` | Good — covers version from env, missing env, response shape, content-type header |
| `test/infra/message-store.test.ts` | Good — verifies both tables, all key schemas, billing mode, PITR, TTL, GSI, deletion policy |
| `test/infra/message-processing.test.ts` | Good — verifies SQS, DLQ, Lambda config, event source, IAM, alarms |
| `test/infra/ingestion-api.test.ts` | Good — verifies HTTP API, routes, Lambda configs, env vars, IAM permissions |
| `test/infra/stack.test.ts` | Good — integration test verifying resource counts, secrets, log group retention |
| `test/scripts/register-webhook.test.sh` | Good — validates arg checking, dependency checking, help output |

### Test gaps:
- No test for the `isTextMessage` guard when `message` exists but `from` is undefined (channel post scenario)
- Worker test TTL computation (line 193-205) is validated against `createdAt` derived from the same `Date.now()` call, making it a tautological check. It cannot catch off-by-one errors in the TTL calculation logic.

---

## File-by-File Summary

| File | Verdict |
|------|---------|
| `package.json` | Clean |
| `tsconfig.json` | Clean |
| `tsconfig.cdk.json` | Clean |
| `vitest.config.ts` | Clean |
| `.eslintrc.cjs` | Clean |
| `.prettierrc` | Clean |
| `cdk.json` | Clean |
| `.npmrc` | Clean |
| `.gitignore` | Clean |
| `src/shared/types/telegram.ts` | Clean |
| `src/shared/utils/secrets.ts` | N2 (non-null assertion) |
| `src/handlers/ingest/index.ts` | B1 (no logging), B2 (no ESM bundling), N1, N3, N8 |
| `src/handlers/worker/index.ts` | B1 (no logging), B3 (no batchItemFailures return) |
| `src/handlers/health/index.ts` | B1 (no logging) |
| `infra/app.ts` | Clean |
| `infra/stack.ts` | N4 (unused var) |
| `infra/config.ts` | N5 (unused constants) |
| `infra/constructs/ingestion-api.ts` | B2 (missing bundling config) |
| `infra/constructs/message-processing.ts` | N6 (alarm does not match PRD spec) |
| `infra/constructs/message-store.ts` | Clean |
| `scripts/register-webhook.sh` | N7 (secret name mismatch) |
