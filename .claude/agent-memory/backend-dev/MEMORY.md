# Backend Dev Agent Memory

## Project Structure
- ESM project (`"type": "module"` in package.json)
- Path alias: `@shared/*` -> `./src/shared/*` (configured in tsconfig.json and vitest.config.ts)
- Test runner: vitest v4.0.18
- Package manager: pnpm v10.23.0

## pnpm Gotchas
- `pnpm approve-builds` is interactive; doesn't work in non-interactive shells
- Use `pnpm.onlyBuiltDependencies` in package.json instead (e.g., for esbuild)
- Duplicate task assignment messages can arrive after completion; just ignore them

## Vitest v4 Mock Gotchas

### Arrow function mocks + `new` keyword
- `vi.fn().mockImplementation(() => ...)` with arrow functions produces a WARNING in Vitest v4
- Vitest v4 warns: "The vi.fn() mock did not use 'function' or 'class' in its implementation"
- Despite the warning, `new` still works at runtime — the warning is non-fatal
- Previous note about needing cast pattern was overly cautious; linter reverts casts anyway

### vi.mock hoisting + const TDZ
- `vi.mock` factories are hoisted above `const` declarations
- If a factory directly references a `const` variable (e.g., `getSecret: getSecretMock`), it causes TDZ ReferenceError
- If a factory captures a variable in a closure (e.g., `mockImplementation(() => ({ send: sqsSendMock }))`), it works because the closure defers access
- Workaround for static imports that trigger TDZ: use dynamic `await import()` inside the handler function instead of top-level static import
- Example: `const { getSecret } = await import("@shared/utils/secrets");` instead of `import { getSecret } from "@shared/utils/secrets";`

### clearMocks config
- Tests that use `vi.mock` factories with `vi.fn()` inside often need `clearMocks: true` in vitest.config.ts
- Without it, mock call counts accumulate across tests within the same file
- Added `clearMocks: true` to vitest.config.ts for this project

## Key Files Implemented
- `src/shared/types/telegram.ts` - Telegram interfaces + isTextMessage type guard
- `src/shared/utils/secrets.ts` - AWS Secrets Manager wrapper with 5-min TTL cache
- `src/handlers/worker/index.ts` - Worker Lambda: SQS -> DynamoDB PutItem with idempotency
- `src/handlers/ingest/index.ts` - Ingest Lambda: Telegram webhook -> SQS
