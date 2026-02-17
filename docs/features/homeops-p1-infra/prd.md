# PRD: Infrastructure & Telegram Ingestion

**Feature ID:** homeops-p1-infra
**Project:** HomeOps
**Phase:** 1 of 6
**Roadmap:** `/docs/projects/homeops/roadmap.md`
**Status:** Phase 0 — Scoping

## Goal

Deploy the core AWS serverless stack in eu-north-1 and wire Telegram group chat messages through an ingestion pipeline into DynamoDB, producing a working message store that all future phases build on.

## Background

HomeOps is a passive household intelligence agent that lives in a Telegram group chat. This first phase establishes the infrastructure foundation: a CDK-managed serverless stack that receives Telegram webhook updates, queues them for processing, and persists raw messages. No intelligence yet — just reliable message flow.

## Architecture

```
Telegram Bot API
       │
       ▼
 API Gateway (webhook endpoint)
       │
       ▼
 Ingest Lambda (validate + enqueue)
       │
       ▼
    SQS Queue (buffer + retry)
       │
       ▼
 Worker Lambda (dequeue + store)
       │
       ▼
   DynamoDB (raw messages table)
```

## In Scope

### 1. Project Setup
- Monorepo structure: `/infra` (CDK), `/src` (Lambda handlers), `/test`
- TypeScript for both CDK and Lambda handlers
- Package manager, linting, tsconfig

### 2. Telegram Bot Creation
- Create bot via @BotFather (manual prerequisite, documented)
- Store bot token in AWS Secrets Manager
- Register webhook URL pointing to API Gateway endpoint
- Webhook registration script/command for setup and updates

### 3. CDK Stack (eu-north-1)
- **API Gateway**: HTTP API with POST route for Telegram webhook
- **Ingest Lambda**: Receives webhook, validates Telegram update structure, extracts message, publishes to SQS
- **SQS Queue**: Standard queue with DLQ for failed messages, visibility timeout tuned for worker processing time
- **Worker Lambda**: Triggered by SQS event source, processes messages, writes to DynamoDB
- **DynamoDB Table**: Raw messages table — partition key: `chatId`, sort key: `messageId`. Attributes: userId, userName, text, timestamp, raw (full Telegram update JSON)
- **Secrets Manager**: Telegram bot token, OpenAI API key (stored now, used in Phase 2)
- **CloudWatch**: Lambda log groups with retention policy

### 4. Ingest Lambda
- Validate incoming request is a Telegram update (check structure, reject malformed)
- Optionally validate Telegram secret token (if configured)
- Extract message payload from update
- Skip non-message updates (edited messages, callbacks, etc.) — only process new text messages
- Enqueue to SQS with `messageId` as deduplication attribute
- Return 200 to Telegram immediately (Telegram retries on non-2xx)

### 5. Worker Lambda
- Triggered by SQS event source mapping (batch size 1 initially)
- Idempotent: check if messageId already exists before writing
- Write raw message to DynamoDB
- Structured logging (JSON) for all operations
- Failed messages go to DLQ after 3 retries

### 6. Health Check
- Separate API Gateway route (`GET /health`) returning `{ "status": "ok", "version": "<deploy-version>" }`

### 7. Security
- All IAM roles follow least privilege (Lambda can only access its specific resources)
- DynamoDB encryption at rest (AWS-managed key)
- Secrets Manager for all sensitive values — no hardcoded tokens
- API Gateway endpoint is public (Telegram requires this) but validates incoming payload structure

### 8. Reliability
- End-to-end latency target: <2s from webhook receipt to DB write
- SQS provides at-least-once delivery; idempotent worker prevents duplicate storage
- DLQ captures poison messages for debugging
- CloudWatch alarms: DLQ depth > 0, Lambda error rate > 5%

## Out of Scope

- Message classification / NLP (→ Phase 2)
- Activity logging / structured events (→ Phase 2)
- Sending responses back to Telegram (→ Phase 2)
- OpenAI API calls (→ Phase 2)
- DM message handling (→ Phase 3)
- Learning system (→ Phase 3)
- Balance calculation (→ Phase 4)
- Promise detection (→ Phase 5)
- EventBridge scheduling (→ Phase 5)
- CI/CD pipeline (future — deploy locally for now)

## Success Criteria

- [ ] `cdk deploy` succeeds and creates all resources in eu-north-1
- [ ] Telegram bot created and webhook registered to API Gateway endpoint
- [ ] Sending a message in the Telegram group results in a raw message record in DynamoDB
- [ ] Full pipeline works: API Gateway → Ingest Lambda → SQS → Worker Lambda → DynamoDB
- [ ] Duplicate Telegram messages (retries) do not create duplicate DB records
- [ ] End-to-end latency (webhook to DB write) is <2s
- [ ] Secrets (bot token, OpenAI key) stored in Secrets Manager and read by Lambdas at runtime
- [ ] `GET /health` returns 200 with status and version
- [ ] CloudWatch logs capture structured JSON for all Lambda invocations
- [ ] DLQ alarm fires when messages fail processing
- [ ] IAM roles are scoped to minimum required permissions
- [ ] `cdk destroy` cleanly removes all resources

## Constraints

- **AWS Serverless only** — no EC2, ECS, Fargate
- **CDK (TypeScript)** for all infrastructure
- **TypeScript** for all Lambda handlers
- **DynamoDB** as primary datastore
- **eu-north-1** region
- **Local CDK deploy** — no CI/CD pipeline in this phase
- **Single worker** — but architecture must not prevent future multi-worker scaling
- **Monorepo** — `/infra`, `/src`, `/test` at project root

## DynamoDB Table Design (Initial)

### `messages` table
| Attribute   | Type   | Key        |
|-------------|--------|------------|
| chatId      | String | PK         |
| messageId   | Number | SK         |
| userId      | Number |            |
| userName    | String |            |
| text        | String |            |
| timestamp   | Number | (Unix ms)  |
| raw         | String | (JSON)     |
| createdAt   | String | (ISO 8601) |

Future phases will add tables/GSIs for events, aliases, preferences, patterns, and promises. The single-table vs multi-table decision should be researched in Phase 1.

## Suggested Research Areas

1. **Telegram Bot API webhook**: Best practices for API Gateway integration — secret token validation, update structure, webhook registration/deregistration, retry behavior
2. **SQS queue configuration**: Standard vs FIFO for this use case, deduplication strategies, visibility timeout, DLQ configuration, batch processing considerations
3. **DynamoDB table design**: Single-table design (all HomeOps data in one table with GSIs) vs separate tables per entity — trade-offs for the full data model across all 6 phases
4. **CDK project patterns**: Monorepo structure for multi-Lambda CDK apps, shared code/types between Lambdas, bundling with esbuild, environment configuration
