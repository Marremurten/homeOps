# Security Reviewer Memory

## Project: HomeOps
- AWS CDK serverless project (TypeScript, ESM, pnpm)
- Region: eu-north-1
- Telegram bot ingestion pipeline: API Gateway -> Lambda -> SQS -> Lambda -> DynamoDB

## Auth/AuthZ Patterns
- Telegram webhook validated via `x-telegram-bot-api-secret-token` header
- Secrets stored in AWS Secrets Manager (bot token, webhook secret, OpenAI key)
- Secret fetched at runtime via `getSecret(arn)` with 5-min in-memory cache
- IAM least privilege via CDK grant methods (e.g., `table.grant(fn, "dynamodb:PutItem")`)

## Input Validation Patterns
- `isTextMessage()` type guard filters non-text Telegram updates
- JSON.parse on untrusted webhook body (no schema validation beyond type guard)
- Conditional DynamoDB PutItem for idempotency (`attribute_not_exists`)

## Known Gaps (Phase 1)
- No structured logging in any Lambda handler
- Ingest Lambda and Health Lambda missing ESM bundling config (worker has it)
- No API Gateway throttling configured
- Shell script uses string interpolation for JSON (should use jq)
- `from` field on TelegramMessage not guarded in ingest handler
- String comparison for secret token is not timing-safe (low practical risk)
- DynamoDB tables use DESTROY removal policy (intentional for dev)

## Security Review Output Location
- `/docs/features/<feature>/verify/security.md`
