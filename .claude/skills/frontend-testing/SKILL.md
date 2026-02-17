---
name: frontend-testing
description: Frontend testing patterns and conventions. Use when writing or modifying tests.
---

## File Structure

Tests go in `/tests/` mirroring the source structure:

- `/tests/<feature>-ui.test.ts` — frontend component tests
- `/tests/<feature>-api.test.ts` — backend API tests
- `/tests/integration/` — E2E and cross-layer tests
- `/tests/helpers/` — shared test utilities

## Rules

- **Write tests BEFORE implementation code** — always
- Test user behavior, not implementation details
- Descriptive test names: `"should [expected behavior] when [condition]"`
- Both happy path and error scenarios

## What to Test

- Component rendering with expected props
- User interactions (click, type, submit)
- State changes reflected in UI
- Error states and loading states
- API response handling (success and failure)

## What NOT to Test

- Internal state shape or store internals
- CSS classes or styling details
- Third-party library internals
- Private functions — test through public API

## Patterns

- Use existing test helpers in `/tests/helpers/` before writing new ones
- Mock API calls, not stores — test the full component+store integration
- For Socket.IO tests, mock the socket connection
- Read existing tests before writing new ones to match patterns
