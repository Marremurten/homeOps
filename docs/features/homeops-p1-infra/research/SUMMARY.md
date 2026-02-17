# Research Synthesis: HomeOps Phase 1 Infrastructure

**Feature:** homeops-p1-infra
**Date:** 2026-02-17
**Inputs:** 4 research files (Telegram webhook, SQS configuration, DynamoDB design, CDK patterns) + PRD

---

## Recommended Approach

Phase 1 deploys a narrow, reliable pipeline: Telegram webhook to DynamoDB via SQS, managed entirely by CDK in eu-north-1. The entire stack costs approximately $0.01/month and fits comfortably within AWS Free Tier.

**Ingestion path.** Telegram delivers webhook updates as HTTPS POSTs to an API Gateway HTTP API (not REST API -- 71% cheaper, lower latency, simpler event format). The Ingest Lambda validates the `x-telegram-bot-api-secret-token` header against a value stored in Secrets Manager, parses the Telegram Update JSON, filters to only new text messages, enqueues to a Standard SQS queue, and returns 200 immediately. Returning 200 fast is critical -- Telegram retries on non-2xx and blocks all subsequent updates until the retry succeeds. The Ingest Lambda should complete in under 500ms; its timeout is set to 10 seconds.

**Processing path.** The Worker Lambda is triggered by an SQS event source mapping with batch size 1. It performs an idempotent conditional write to DynamoDB (`attribute_not_exists(chatId) AND attribute_not_exists(messageId)`). Duplicates from Telegram retries or SQS at-least-once delivery result in a no-op `ConditionalCheckFailedException`, which the worker catches and treats as success. Failed messages move to a DLQ after 3 receive attempts; a CloudWatch alarm fires on any DLQ message.

**Data storage.** A single `homeops-messages` table with `chatId` (String, PK) and `messageId` (Number, SK). No GSIs needed for Phase 1. On-demand billing mode. The PRD's full 6-phase data model is served by a hybrid design: this dedicated messages table plus a shared `homeops` single-table-design table created in Phase 2 for events, users, aliases, balances, promises, and summaries. This defers complexity without creating migration debt.

**Project structure.** A flat monorepo with a single `package.json` at root, no workspaces. `/infra` holds CDK code (app entry point, one stack, three grouping constructs: IngestionApi, MessageProcessing, MessageStore). `/src` holds Lambda handlers in per-handler directories plus `shared/types` and `shared/utils`. `/test` mirrors the source layout. The `NodejsFunction` construct handles esbuild bundling -- ESM format, minified, with inline source maps, bundling the AWS SDK v3 (tree-shaken) for faster cold starts. Node.js 22 on ARM64 (Graviton).

**Secrets.** Bot token and webhook secret token stored in Secrets Manager. Lambdas receive the secret ARN as an environment variable and fetch the value at runtime using the SDK with module-scope caching (5-minute TTL). No Lambda extension needed for 2 functions.

**Webhook registration.** A shell script (`scripts/register-webhook.sh`) calls the Telegram `setWebhook` API with `allowed_updates: ["message"]`, `drop_pending_updates: true`, and `max_connections: 10`. This is a manual step, not automated in CDK.

---

## Key Findings

### Telegram Webhook Behavior
- Telegram retries with exponential backoff on non-2xx responses and disables the webhook entirely after hours of failures. This makes the SQS buffer between ingest and processing essential.
- Updates are delivered in order; a failed update blocks all subsequent updates.
- Observed timeout for webhook responses is ~30 seconds, but the Ingest Lambda should respond in <500ms.
- `allowed_updates: ["message"]` at registration time prevents Telegram from sending edited messages, reactions, callbacks, etc., reducing Lambda invocations.
- API Gateway HTTP API payload format 2.0 lowercases all headers, so the secret token header arrives as `x-telegram-bot-api-secret-token`.
- Return 200 for everything from Telegram (validated by secret token), except SQS enqueue failure (return 500 to trigger retry).

### SQS Configuration
- **Standard queue, not FIFO.** Ordering is irrelevant (DynamoDB records have timestamps and messageId for reconstruction). FIFO's exactly-once delivery is redundant given app-level deduplication. FIFO adds MessageGroupId, MessageDeduplicationId, and `.fifo` suffix requirements for zero benefit.
- **Visibility timeout: 180 seconds** (6x the 30-second Worker Lambda timeout, per AWS recommendation).
- **DLQ retention: 14 days** (SQS maximum). Main queue retention: 4 days (default).
- **maxReceiveCount: 3** (per PRD). AWS recommends >=5 for Lambda integrations, but throttling is impossible at ~200 messages/day.
- **Enable `reportBatchItemFailures: true`** even with batch size 1, for zero-cost future-proofing.
- Total SQS requests: ~148,000/month (mostly empty polls), well within the 1 million free tier.

### DynamoDB Design
- **Hybrid approach:** dedicated `homeops-messages` table (Phase 1) + shared `homeops` single-table-design table (Phase 2+).
- Messages table: `chatId` (String PK), `messageId` (Number SK). No GSIs. On-demand billing.
- Telegram's `messageId` is monotonically increasing per chat, making it a natural chronological sort key and deduplication key.
- All other entities (events ~500-2000/mo, aliases ~20-50, preferences ~5-10, balances ~100-500, promises ~50-200, summaries ~10-50) go in the `homeops` table with entity-prefixed composite keys and a single overloaded GSI.
- Adding new entity types to the single-table requires zero migration -- just start writing items with new PK/SK patterns. GSIs backfill automatically.
- Enable point-in-time recovery (effectively free at <1 GB).

### CDK & Project Structure
- Single stack, single `cdk deploy`. Fewer than 50 resources, all tightly coupled.
- Three grouping constructs (not L3 patterns): `IngestionApi`, `MessageProcessing`, `MessageStore`.
- `NodejsFunction` with esbuild: `externalModules: []` (bundle SDK), `format: ESM`, `minify: true`, `sourceMap: true`, `target: node22`.
- ESM banner required: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`
- Cold start budget: ~400-575ms total (runtime init ~100ms, code load ~150-250ms, SDK overhead ~100-125ms, secrets fetch ~50-100ms). Well under 2-second target.
- Two tsconfigs: base `tsconfig.json` (IDE + esbuild) and `tsconfig.cdk.json` (CDK compilation, extends base).
- Custom minimal Telegram types (5 interfaces) rather than importing `@telegraf/types`. Switch to the package in Phase 2 when send-message capabilities are needed.

### Cost
- Entire stack: ~$0.01/month. All services within Free Tier at household scale (~200 messages/day).
- DynamoDB on-demand at this volume: ~$0.01/month. Provisioned free tier: $0.00/month.
- SQS: $0.00/month (148K requests vs 1M free tier).
- Lambda: $0.00/month (~400 invocations/day vs 1M/month free tier).

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Telegram disables webhook after sustained failures | Low | High -- silent message loss | CloudWatch alarm on DLQ depth. Consider periodic `getWebhookInfo` health check (see Open Decisions). |
| SQS message exceeds 256 KB limit | Very low | Medium -- message lost | Telegram updates are typically 1-5 KB. Ingest Lambda should validate size before enqueuing. Edge case with photo/document metadata. |
| Cold start exceeds 2s latency target | Very low | Low -- Telegram has 30s timeout | Estimated cold start is 400-575ms. Keep Ingest Lambda minimal (no DynamoDB, no heavy processing). Bundle SDK for tree-shaking. |
| Spoofed webhook requests | Medium | Low -- fake data in DB | Secret token validation returns 401 for mismatches. Token stored in Secrets Manager, not environment variables. |
| DLQ messages accumulate unnoticed | Medium | Low -- messages stuck in DLQ | CloudWatch alarm fires on any DLQ message. DLQ retention set to 14 days. Built-in DLQ redrive available for replay. |
| `maxReceiveCount: 3` causes false DLQ routing | Very low | Low -- recoverable via redrive | At ~200 msg/day, Lambda throttling is impossible. Increase to 5 if false positives observed in practice. |
| Node.js 20 EOL (April 2026) | Certain | Low if on 22 | Use Node.js 22 from day one. |
| Secret token rotation causes brief 401 window | Low | Low -- Telegram retries | Accept brief retry period during rotation, or implement dual-token validation window. |

---

## Resolved Decisions

Decided by project owner on 2026-02-17:

1. **DLQ alarm notification target** → **CloudWatch console only.** No SNS topic or email subscription. Monitor via CloudWatch dashboard.
2. **Webhook health monitoring** → **Skip.** No periodic `getWebhookInfo` check. Rely on DLQ alarm and manual monitoring.
3. **TTL on raw messages** → **90-day expiry.** Enable DynamoDB TTL on a `ttl` attribute (Unix epoch, set to `createdAt + 90 days`).
4. **Test framework** → **Vitest.** Native TypeScript, fast, compatible with CDK assertions.
5. **Path aliases** → **`@shared/...` aliases.** Configure tsconfig `paths` and `NodejsFunction` bundling `tsconfig` option.
6. **CDK app runner** → **`tsx`.** Newer, better ESM handling.
7. **Telegram IP allowlisting** → **Secret token sufficient.** No CloudFront or IP filtering. Secret token validation provides adequate security.
8. **`homeops` single-table** → **Create in Phase 1.** Costs nothing, validates CDK code, ready for Phase 2.

---

## Conflicts

### Visibility Timeout: 30s vs 180s

The CDK patterns researcher's construct example sets `visibilityTimeout: Duration.seconds(30)` on the SQS queue, while the SQS configuration researcher explicitly calculates 180 seconds (6x the 30-second Lambda timeout) following AWS's documented recommendation. **Resolution: use 180 seconds.** The AWS documentation states Lambda validates that function timeout does not exceed queue visibility timeout, and the 6x multiplier accounts for internal retry behavior. The 30s value in the CDK construct example appears to be a simplified placeholder.

### Ingest Lambda Timeout: 10s vs 30s

The Telegram webhook researcher recommends a 10-second timeout for the Ingest Lambda (actual execution <500ms, generous margin against Telegram's ~30s observed timeout). The SQS researcher's CDK example uses 30 seconds for the Worker Lambda. These are not in conflict -- they are different Lambdas with different workloads. **Clarification: Ingest Lambda = 10s timeout, Worker Lambda = 30s timeout.** The visibility timeout calculation (6x) applies to the Worker Lambda timeout.

### `chatId` Type: String vs Number

The PRD specifies `chatId` as String (PK) but also shows it derived from `message.chat.id` which is a Number in the Telegram API. The DynamoDB researcher uses String with a `CHAT#` prefix for the `homeops` table but recommends raw (unprefixed) String for the messages table. The Telegram webhook researcher maps it as `Number (as String)`. **Resolution: store as String (the string representation of the number) in the messages table, with no prefix.** Use prefixed keys only in the Phase 2+ `homeops` table. This matches the PRD's simple schema while keeping the door open for prefixed keys later.

### Custom Types vs `@telegraf/types`

The Telegram webhook researcher recommends custom minimal types (5 interfaces, zero dependencies). The CDK patterns researcher defines similar types in `/src/shared/types/telegram.ts`. Both agree on custom types for Phase 1. No real conflict -- the CDK researcher's types are effectively the same recommendation expressed as a directory structure example. **Resolution: custom minimal types in `src/shared/types/telegram.ts`, switch to `@telegraf/types` in Phase 2 if needed.**

### DynamoDB Billing Mode

The DynamoDB researcher recommends on-demand for Phase 1 (eliminates throttling risk during development, ~$0.01/month) but notes provisioned free tier is $0.00/month. **Resolution: on-demand for Phase 1.** The $0.01/month cost difference is negligible, and on-demand removes one class of potential issues during development. Can switch to provisioned later.

---

## Research File Index

| File | Summary |
|------|---------|
| `telegram-webhook.md` | Telegram Bot API webhook integration: registration, payload structure, secret token validation, HTTP API vs REST API, retry behavior, error handling decision matrix, and custom TypeScript type definitions. |
| `sqs-configuration.md` | SQS queue design: Standard vs FIFO analysis, application-level deduplication via DynamoDB conditional writes, visibility timeout calculation (180s), DLQ configuration (maxReceiveCount 3, 14-day retention), batch processing settings, and complete CDK code for queue + DLQ + event source mapping. |
| `dynamodb-design.md` | DynamoDB table design across all 6 phases: entity inventory, access patterns, single-table vs multi-table vs hybrid analysis, detailed schema for both tables, GSI strategy, cost analysis, and migration path. Recommends hybrid (messages table + shared homeops table). |
| `cdk-patterns.md` | CDK monorepo structure: directory layout, single package.json rationale, NodejsFunction esbuild bundling configuration (ESM, minified, source maps, bundled SDK), shared types pattern, secrets management, single stack with 3 grouping constructs, testing strategy (Vitest, fine-grained CDK assertions), cold start optimization, and tsconfig setup. |
