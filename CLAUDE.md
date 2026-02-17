# HomeOps

A family Telegram bot for tracking household contributions. Members report chores ("Jag har diskat") or rest ("Vilade en stund") and the bot classifies, stores, and acknowledges them — creating a shared log of who did what around the house.

## Stack

TypeScript ESM, pnpm, AWS CDK (eu-north-1), Vitest v4, OpenAI gpt-4o-mini

## Project Layout

- `src/handlers/` — Lambda handlers (ingest, worker, health)
- `src/shared/services/` — business logic (classifier, activity-store, response-policy, telegram-sender)
- `src/shared/types/` — TypeScript types
- `src/shared/utils/` — helpers (secrets, stockholm-time, tone-validator)
- `infra/` — CDK stack and constructs
- `test/` — mirrors `src/` structure

## Commands

- `pnpm test` — run all tests
- `pnpm cdk diff` — preview infra changes
- `pnpm cdk deploy` — deploy to AWS
- `pnpm lint` — run ESLint

## How It Works

Telegram webhook hits API Gateway. Ingest Lambda validates the secret and enqueues to SQS. Worker Lambda classifies the message via OpenAI, stores the activity in DynamoDB, evaluates the response policy (quiet hours, daily cap, cooldown, confidence threshold), and replies if appropriate.

## Key Gotchas

- All imports require `.js` extension (`NodeNext` module resolution)
- `@shared/*` path alias maps to `./src/shared/*`
- DynamoDB uses raw types (`{ S: "string" }`, `{ N: "123" }`) — not DocumentClient
- DynamoDB reserved keywords (`ttl`, `count`) need `ExpressionAttributeNames`
- Telegram chat IDs are numbers — coerce with `String()` before DynamoDB writes
- Secrets are cached in-memory for 5 minutes (see `src/shared/utils/secrets.ts`)

## Testing

See existing tests for patterns. Tests mirror source structure. Key vitest v4 rules:
- Use `vi.hoisted()` for mock variables used in `vi.mock()` factories
- Use `function` keyword (not arrows) for class mocks called with `new`
- `vi.clearAllMocks()` in `beforeEach`

## AWS Secrets

- `homeops/telegram-bot-token`
- `homeops/webhook-secret`
- `homeops/openai-api-key`
