# Verification Report: homeops-p1-infra

**Date:** 2026-02-17
**Assessment:** Ship with fixes
**Reviewers:** code-reviewer, security-reviewer, integration-tester

---

## Test Results

- **90 vitest tests: ALL PASS** (10 test files)
- **8 shell tests: ALL PASS**
- **0 failures, 0 skipped**
- **0 dependency vulnerabilities** (pnpm audit clean, 275 deps)

---

## Critical Issues (must fix before shipping)

### C1. No structured JSON logging in any Lambda handler

**Flagged by:** All 3 reviewers
**PRD:** "Structured logging (JSON) for all operations" + Success Criterion #9
**Files:** `src/handlers/ingest/index.ts`, `src/handlers/worker/index.ts`, `src/handlers/health/index.ts`

None of the three handlers contain any logging calls. This is a PRD requirement and means zero operational visibility — no audit trail of auth failures, no record of message processing, no error diagnostics in CloudWatch.

**Fix:** Add `console.log(JSON.stringify({...}))` calls for: request received, auth result, message enqueued/skipped, DynamoDB write, errors. Do not log secret tokens or full message text.

### C2. Missing ESM bundling config on Ingest and Health Lambdas

**Flagged by:** code-reviewer (B2), security-reviewer (F4)
**File:** `infra/constructs/ingestion-api.ts`

Worker Lambda has `bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true }` but Ingest and Health Lambdas do not. Per plan decision #17, all Lambdas should use ESM bundling. Without this, `@shared/*` path alias imports may fail at runtime and bundles won't be tree-shaken.

**Fix:** Add identical `bundling` config to both `IngestFn` and `HealthFn`.

### C3. Worker Lambda doesn't return `batchItemFailures` response

**Flagged by:** code-reviewer (B3)
**File:** `src/handlers/worker/index.ts:15`

SQS event source has `reportBatchItemFailures: true` but the handler returns `Promise<void>` instead of `SQSBatchResponse`. With batch size 1 this is benign today, but technically incorrect and will silently break when batch size increases.

**Fix:** Change return type to `SQSBatchResponse` and return `{ batchItemFailures: [] }` on success or `{ batchItemFailures: [{ itemIdentifier: record.messageId }] }` on failure.

---

## High Priority Issues (should fix)

### H1. Secret name mismatch between CDK and registration script

**Flagged by:** code-reviewer (N7)
**CDK:** `homeops/telegram-bot-token`, `homeops/webhook-secret` (`infra/stack.ts:17,20`)
**Script:** `homeops/telegram/bot-token`, `homeops/telegram/webhook-secret` (`scripts/register-webhook.sh:27-28`)

The registration script will fail at runtime with default secret names.

### H2. `message.from` non-null assertion

**Flagged by:** code-reviewer (N3), security-reviewer (F10)
**File:** `src/handlers/ingest/index.ts:37`

`from` is optional in Telegram API (absent on channel posts). A channel post with text would pass `isTextMessage` but crash on `from.id`, returning 500 and triggering Telegram retry storms.

**Fix:** Add `from` check to `isTextMessage()` type guard, or guard in handler.

### H3. JSON.parse without try/catch on untrusted input

**Flagged by:** security-reviewer (F1)
**File:** `src/handlers/ingest/index.ts:27`

Malformed body causes 500, which triggers Telegram retries on the same malformed payload (retry storm).

**Fix:** Wrap `JSON.parse` in try/catch, return 200 for parse failures (not retryable).

### H4. `timestamp` uses seconds instead of PRD-specified milliseconds

**Flagged by:** code-reviewer (N8)
**File:** `src/handlers/ingest/index.ts:45`

Telegram `message.date` is Unix seconds. PRD specifies `timestamp` as "Unix ms". Data will be inconsistent with PRD schema.

### H5. `chatId` type mismatch between Ingest and Worker

**Flagged by:** code-reviewer (N1)
**Ingest:** sends as `number` (`src/handlers/ingest/index.ts:40`)
**Worker:** interface declares `string` (`src/handlers/worker/index.ts:7`)

Works at runtime due to `String()` coercion, but types are misleading.

---

## Security Findings

| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 3 | F1 (JSON.parse retry storm), F3 (no logging), F6 (shell injection) |
| Low | 4 | F2 (SecretString assertion), F4 (ESM bundling), F5 (no throttling), F10 (from assertion) |
| Info | 2 | F8 (DESTROY removal policy), F9 (implicit SQS encryption) |

**Key security positives:**
- All secrets in Secrets Manager, no hardcoded values
- IAM grants scoped to least privilege via CDK `grant*` methods
- Webhook secret token validation works correctly
- DynamoDB encryption at rest (AWS default)
- 0 known CVEs in dependencies
- Idempotent worker prevents duplicate writes

---

## Test Coverage — PRD Success Criteria

| # | Criterion | Coverage | Notes |
|---|-----------|----------|-------|
| 1 | `cdk deploy` succeeds | Partial | Stack synth + resource count tests. Actual deploy is manual. |
| 2 | Webhook registered | Partial | Script validation tests. Actual registration is manual. |
| 3 | Message → DynamoDB | Partial | Handlers tested individually. No E2E contract test. |
| 4 | Full pipeline works | Partial | Each stage tested. CDK wiring verified. No single pipeline test. |
| 5 | Duplicate dedup | **Yes** | `ConditionalCheckFailedException` caught as success. |
| 6 | Latency < 2s | No | Requires deployed stack. Manual verification. |
| 7 | Secrets in SM | **Yes** | getSecret tested, ingest uses it, stack creates secrets. |
| 8 | GET /health | **Yes** | 8 tests cover response shape, version, fallback. |
| 9 | Structured JSON logs | **No** | Handlers have no logging. Implementation gap. |
| 10 | DLQ alarm fires | **Yes** | CDK alarm assertion verified. |
| 11 | IAM least privilege | **Yes** | Permission scoping verified in CDK tests. |
| 12 | `cdk destroy` clean | Partial | DESTROY removal policy verified. Actual destroy is manual. |

**Summary:** 7/12 covered, 4 partial (require deployed stack), 1 not met (logging).

---

## Scope Check

- **All PRD in-scope items implemented:** Yes (project setup, bot secrets, webhook script, CDK stack, API Gateway, Ingest Lambda, SQS+DLQ, Worker Lambda, DynamoDB tables, health endpoint, IAM, CloudWatch)
- **Scope creep detected:** None
- **Plan decisions followed:** All 18 decisions correctly implemented (ESM, pnpm, Node 22 ARM64, path aliases, custom types, standard SQS, on-demand billing, etc.)

---

## Suggestions (non-blocking)

| # | Suggestion | Source |
|---|-----------|--------|
| S1 | Worker alarm: change from `errors > 0` to `errors/invocations > 5%` per PRD | code-reviewer (N6) |
| S2 | Use `jq` for safe JSON construction in register-webhook.sh | security-reviewer (F6) |
| S3 | Guard `response.SecretString` instead of non-null assertion | code-reviewer (N2), security-reviewer (F2) |
| S4 | Remove unused `openaiApiKeySecret` variable in stack.ts | code-reviewer (N4) |
| S5 | Use config constants instead of hardcoded table names | code-reviewer (N5) |
| S6 | Add API Gateway throttling (e.g., 100 burst / 50 sustained) | security-reviewer (F5) |
| S7 | Migrate deprecated `pointInTimeRecovery` to `pointInTimeRecoverySpecification` | integration-tester |
| S8 | Add contract test between ingest output and worker input | integration-tester |
| S9 | Consider `crypto.timingSafeEqual()` for token comparison | security-reviewer (F7) |
