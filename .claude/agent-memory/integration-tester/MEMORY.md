# Integration Tester Memory

## Project Test Setup
- Test runner: Vitest v4.0.18, ESM mode
- Run tests: `pnpm test` from project root
- Test files: `test/` directory mirrors `src/` structure (handlers, shared, infra)
- CDK tests use `aws-cdk-lib/assertions` Template + Match
- Mock pattern: `vi.hoisted()` + `vi.mock()` for all external deps

## Mock Patterns That Work
- DynamoDB: mock `send` on client instance, mock individual Command constructors
- OpenAI: mock `client.beta.chat.completions.parse` via hoisted MockOpenAI constructor
- Telegram: mock `global.fetch` with `vi.fn()`
- Secrets Manager: mock `@shared/utils/secrets.js` getSecret
- Use `function` keyword (not arrow) in `mockImplementation` for classes

## Test File Locations (P2 Classification)
- Shared services: `test/shared/classifier.test.ts`, `activity-store.test.ts`, `response-counter.test.ts`, `fast-conversation.test.ts`, `telegram-sender.test.ts`, `response-policy.test.ts`
- Shared utils: `test/shared/classification-schema.test.ts`, `stockholm-time.test.ts`, `tone-validator.test.ts`
- Handlers: `test/handlers/worker.test.ts`, `test/handlers/ingest.test.ts`
- Infra: `test/infra/message-store.test.ts`, `test/infra/message-processing.test.ts`, `test/infra/stack.test.ts`

## Known CDK Deprecation Warning
- `aws_dynamodb.TableOptions#pointInTimeRecovery` deprecated, should use `pointInTimeRecoverySpecification` -- cosmetic only
