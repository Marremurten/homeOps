# Plan Verifier Memory

## Common Scope Creep Patterns
- Creating "empty" infrastructure for future phases (e.g., empty DynamoDB tables with GSIs for Phase 2)
- Adding TTL/retention attributes not specified in the PRD's data model
- These are easy to miss because they "cost nothing" but widen the testing surface

## Frequently Under-Covered PRD Sections
- Non-functional requirements (latency targets, error rate thresholds) often lack explicit validation tasks
- "Store X for future use" requirements (e.g., "OpenAI key stored now, used Phase 2") get partially implemented -- the secret utility is built but the actual secret creation is forgotten
- Logging requirements that say "all Lambdas" -- plans often only specify logging in the primary handler, not auxiliary ones (health checks, etc.)
- Alarm specifications: PRDs with multiple alarms (DLQ + error rate) often only get the first one implemented

## Verification Edge Cases
- Stack integration tests that import constructs must depend on construct *impl* tasks, not construct *test* tasks -- wave ordering may mask this
- Scaffolding/config tasks (package.json, tsconfig, linting, etc.) easily exceed the 5-file budget -- flag for splitting
- Shell scripts (webhook registration, setup scripts) often lack test tasks -- flag as TDD violation or document exception
- "Structured logging" must be traced to every Lambda, not just the primary data-processing one

## Wave Ordering Subtleties
- CDK constructs that accept typed props (e.g., Table, Queue) can be coded in parallel even if the plan declares inter-construct dependencies -- the actual wiring happens in the stack task
- Declared dependencies may be conservative (correct but not strictly necessary for parallel coding); note for executors but do not flag as violations
- When constructs A -> B -> C are all in the same wave but have declared dependencies, the executor must serialize them within the wave

## Post-Deploy / Manual Verification Pattern
- Non-functional criteria (latency, deploy/destroy success) that cannot be unit-tested should have a "Post-Deploy Manual Verification" section in the plan
- This is an acceptable alternative to test tasks for criteria that require a live stack
- Coverage check should accept Post-Deploy items as valid coverage for success criteria

## Project: homeops
- Monorepo at repo root: /infra, /src, /test
- CDK TypeScript, Lambda TypeScript, pnpm, vitest
- Feature docs at /docs/features/<feature-name>/
- PRD -> plan -> plan-verification workflow
- Research-resolved decisions can add items not in PRD (e.g., homeops table, TTL attribute) -- flag as ACKNOWLEDGED not SCOPE CREEP when plan documents the rationale
