# Scope Brief: Infrastructure & Telegram Ingestion

Project: HomeOps
Phase: 1 of 6
Feature ID: homeops-p1-infra
Roadmap: `/docs/projects/homeops/roadmap.md`

## Goal

Deploy the core AWS serverless stack and wire Telegram messages through the ingestion pipeline to persistent storage.

## In Scope

- **CDK Stack** (§22): API Gateway, Lambda (ingest + worker), SQS queue, DynamoDB tables, CloudWatch logging, Secrets Manager
- **Telegram Webhook** (§9.1, §20): API Gateway endpoint receives Telegram webhook updates, validates them, and enqueues to SQS
- **Message Ingestion Pipeline** (§20): Ingest Lambda receives webhook → SQS queue buffers → Worker Lambda dequeues and stores raw messages in DynamoDB
- **Worker Architecture** (§21): Single worker Lambda triggered by SQS, structured for future scaling
- **Reliability** (§23): <2s latency target, <1% duplicate logs (SQS deduplication), idempotent message processing
- **Security** (§24): Encrypted DynamoDB, least privilege IAM roles, Telegram bot token + OpenAI API key in Secrets Manager
- **Health Check**: Basic endpoint to verify stack is running

## Out of Scope

- Message classification/NLP (→ Phase 2)
- Activity logging (→ Phase 2)
- Response generation / sending messages back to Telegram (→ Phase 2)
- OpenAI integration (→ Phase 2)
- Learning system (→ Phase 3)
- Balance calculation (→ Phase 4)
- Promise detection (→ Phase 5)
- DM handling (→ Phase 3/6)
- EventBridge scheduling (→ Phase 5)

## Prior Phases (what's already built)

(empty — this is the foundation phase)

## Success Criteria

- [ ] CDK stack deploys successfully to AWS
- [ ] Telegram webhook registered and receiving messages
- [ ] Messages flow: API Gateway → Ingest Lambda → SQS → Worker Lambda → DynamoDB
- [ ] Raw messages stored in DynamoDB with timestamp, chat_id, user_id, message text
- [ ] Duplicate messages are not stored twice (<1% duplication)
- [ ] End-to-end latency from Telegram webhook to DB write is <2s
- [ ] Secrets (Telegram token, OpenAI key) stored in Secrets Manager and read by Lambdas
- [ ] Health check endpoint returns 200
- [ ] CloudWatch logs capture all Lambda invocations
- [ ] IAM roles follow least privilege

## Constraints

- AWS Serverless only (no EC2, ECS, etc.)
- CDK for all infrastructure-as-code
- TypeScript for Lambda handlers (consistent with CDK)
- DynamoDB as primary datastore (not Postgres — simpler for serverless)
- Single-region deployment initially
- Must support future multi-worker scaling without architectural changes

## Suggested Research Areas

1. Best practice for Telegram Bot API webhook setup with API Gateway — authentication, update validation, and webhook registration flow
2. SQS FIFO vs Standard queue trade-offs for message ordering and deduplication in this use case
3. DynamoDB table design — single-table vs multi-table for the full HomeOps data model (events, aliases, preferences, patterns, promises)
4. CDK project structure and patterns for a multi-Lambda serverless application with shared layers
