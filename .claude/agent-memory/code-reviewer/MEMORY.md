# Code Reviewer Memory

## Project Conventions (Confirmed P1-Infra)
- ESM throughout: `"type": "module"` in package.json, `.js` extensions on imports
- `@shared/*` path alias maps to `src/shared/*` — needs resolution in both tsconfig and vitest config
- All Lambdas: Node.js 22, ARM64, `NodejsFunction` with ESM bundling (format: ESM, minify, sourceMap)
- DynamoDB: low-level client (`@aws-sdk/client-dynamodb`), not DocumentClient
- Secrets: module-scope cache with 5-min TTL via custom `getSecret()` utility
- CDK constructs: 3 grouping constructs (MessageStore, MessageProcessing, IngestionApi) in single stack
- Mock pattern: `vi.hoisted()` + `function` keyword in `mockImplementation` for class mocks

## Common Review Findings
- Missing structured logging — PRD requires JSON logging in all handlers
- ESM bundling config must be on ALL NodejsFunction instances, not just some
- When `reportBatchItemFailures` is enabled on SQS event source, handler must return `SQSBatchResponse`
- Secret names in CDK vs shell scripts can diverge — always cross-check
- Config constants defined but never imported is a recurring pattern to watch for
- CloudWatch "error rate" alarms need math expressions (errors/invocations), not raw error count

## Review Approach
- Read PRD + plan first for requirements baseline
- Check all handlers for: logging, error handling, return types matching infra config
- Cross-reference CDK construct props with actual handler env var usage
- Verify secret/resource names match between CDK, handlers, and scripts
- Check that test assertions match PRD spec, not just implementation
