# Researcher Agent Memory

## Project: HomeOps
- Household intelligence agent, Telegram-based, AWS serverless (CDK TypeScript)
- Region: eu-north-1
- 6-phase roadmap: Phase 1 = infra + ingestion, Phase 2 = classification, etc.
- PRD: `/docs/projects/homeops/prd.md`
- Roadmap: `/docs/projects/homeops/roadmap.md`
- Phase 1 PRD: `/docs/features/homeops-p1-infra/prd.md`

## Architecture (Phase 1)
- Telegram Bot API -> API Gateway -> Ingest Lambda -> SQS -> Worker Lambda -> DynamoDB
- DynamoDB table: `messages` (PK: chatId, SK: messageId)
- Low throughput: 50-200 messages/day

## Key Decisions
- Standard SQS queue (not FIFO) - app-level idempotency via DynamoDB conditional writes
  - See: `/docs/features/homeops-p1-infra/research/sqs-configuration.md`
- DynamoDB hybrid design: `homeops-messages` (Phase 1) + `homeops` single-table (Phase 2+)
  - Messages table: chatId PK, messageId SK, on-demand billing, no GSIs needed Phase 1
  - Shared table uses PK/SK entity prefixes (CHAT#, USER#, EVENT#, etc.) + one GSI (GSI1PK/GSI1SK)
  - Cost at household scale: ~$0/month (well within free tier)
  - See: `/docs/features/homeops-p1-infra/research/dynamodb-design.md`
- CDK monorepo patterns: single package.json, NodejsFunction+esbuild (ESM, bundled SDK), single stack, Node.js 22 ARM64
  - 3 logical constructs: IngestionApi, MessageProcessing, MessageStore
  - Runtime secrets fetch with module-scope caching (not Lambda extension)
  - Base tsconfig.json + tsconfig.cdk.json extension pattern
  - See: `/docs/features/homeops-p1-infra/research/cdk-patterns.md`
- Telegram webhook integration: HTTP API (not REST API), secret_token validation, custom minimal TS types
  - allowed_updates: ["message"] to reduce Lambda invocations
  - Always return 200 except on SQS failure (500) or invalid secret (401)
  - Payload format 2.0: headers lowercased, body is string to JSON.parse
  - Secret token stored in Secrets Manager, cached at cold start
  - See: `/docs/features/homeops-p1-infra/research/telegram-webhook.md`

## Research Approaches
- WebSearch is effective for AWS pricing, CDK patterns, and best practices
- WebFetch is denied in this environment; rely on WebSearch summaries
- Always read the PRD first to anchor research in specific requirements
- Cross-reference PRD line numbers when justifying decisions

## Codebase Structure
- No TypeScript source files exist yet (Phase 0 - Scoping)
- Monorepo planned: `/infra` (CDK), `/src` (Lambda handlers), `/test`
- Research outputs: `/docs/features/homeops-p1-infra/research/`
