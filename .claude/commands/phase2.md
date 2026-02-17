# Phase 2: Technical Plan — $ARGUMENTS

You are starting **Phase 2 (Technical Plan)** for feature: **$ARGUMENTS**

## Step 1: Read inputs

Read these files (and ONLY these):

- `/docs/features/$ARGUMENTS/prd.md`
- `/docs/features/$ARGUMENTS/research/SUMMARY.md`
- `/docs/tech-preferences.md`

Do NOT read individual research files — the summary is sufficient.

## Step 2: Resolve technical decisions

Compare the research recommendations against the user's tech preferences:

- **Auto-resolve**: If a research recommendation matches a standing preference, adopt it without asking.
- **Override with preference**: If research recommends something different but the user has a standing preference, default to the preference — unless the research identifies a strong reason not to (e.g., "Express cannot handle this use case").
- **New decisions**: For choices NOT covered by tech preferences, present them to the user.

Present a **decision checkpoint** to the user:

```
Decisions (auto-resolved from your preferences):
  ✓ Express for API routes (matches preference)
  ✓ Zustand for state (matches preference)

Decisions that need your input:
  1. Conflict resolution: CRDT vs OT — research recommends CRDT because...
  2. File upload: multer vs busboy — research recommends multer because...
```

Wait for user input on unresolved decisions before proceeding.

## Step 3: Write the plan

Write `/docs/features/$ARGUMENTS/plan.md` with the following structure:

### Decisions Log

For each technical choice, one line:

- What was chosen, what was the alternative, and why (preference / research recommendation / user decision)

### DB Changes

Schema modifications if any — table definitions, migrations.

### API Contracts

Endpoints, request/response shapes.

### Implementation Tasks (TDD pairs)

Break ALL implementation work into **TDD task pairs**. Each piece of work becomes TWO tasks:

1. **Test task** — writes failing tests based on the spec. The agent has NO implementation to look at.
2. **Implementation task** — reads the tests from the test task and writes code to make them pass.

Each task (test or impl):

- Touches **max 3-5 files** (if more, split into smaller tasks)
- Has a clear **description** of what to test or build
- Lists the **exact files** to create or modify
- Lists **dependencies** on other tasks (by task number)
- Is self-contained — an agent with fresh context can complete it by reading only the listed files

Example format:

```md
#### Task 1-test: Org table migration tests

- Type: test
- Files: server/db/**tests**/orgs-migration.test.ts
- Dependencies: none
- Description: Write tests that verify the organizations table exists with columns
  id (text, PK), name (text, not null), created_at (text, not null). Test insert,
  read, and unique constraint on name.

#### Task 1-impl: Org table migration

- Type: impl
- Files: server/db/migrations/001-add-orgs.ts, server/db/schema.ts
- Dependencies: Task 1-test
- Description: Implement the organizations table migration. Read the tests at
  server/db/**tests**/orgs-migration.test.ts first — your goal is to make them pass.

#### Task 2-test: Org middleware tests

- Type: test
- Files: server/middleware/**tests**/org-context.test.ts
- Dependencies: Task 1-impl
- Description: Write tests for middleware that reads org_id from session and
  attaches to req. Test: valid org_id passes, missing org_id returns 403,
  invalid org_id returns 403.

#### Task 2-impl: Org middleware

- Type: impl
- Files: server/middleware/org-context.ts, server/middleware/index.ts
- Dependencies: Task 2-test
- Description: Implement org context middleware. Read the tests at
  server/middleware/**tests**/org-context.test.ts first — your goal is to make them pass.
```

### Execution Waves

Group tasks into waves based on dependencies. Test tasks come before their corresponding impl tasks. Tasks within a wave can run in parallel.

```md
Wave 1: Task 1-test (no dependencies)
Wave 2: Task 1-impl (depends: 1-test), Task 2-test (depends: 1-test — needs schema types)
Wave 3: Task 2-impl (depends: 2-test), Task 3-test (depends: 1-impl)
Wave 4: Task 3-impl (depends: 3-test), Task 4-test (depends: 2-impl)
...
```

Note: A test task for feature B can run in parallel with an impl task for feature A, as long as the test task's dependencies are met. Maximize parallelism by interleaving test and impl tasks across waves.

### Context Budget Check

After writing all tasks, verify:

- [ ] No task touches more than 5 files
- [ ] Each task description is under 20 lines
- [ ] Each task can be understood without reading the full plan
- [ ] Dependencies are explicit — no implicit ordering
- [ ] Every impl task depends on its corresponding test task
- [ ] No test task depends on its own impl task

If any check fails, split the task further.

## Step 4: Verify the plan

Spawn a **plan-verifier** subagent to cross-check the plan against the PRD:

1. **Coverage check** — every PRD success criterion maps to at least one task pair
2. **Scope creep check** — every task traces back to the PRD
3. **Out-of-scope check** — nothing in the plan is listed as out of scope in the PRD
4. **Constraint check** — PRD constraints are reflected in the plan
5. **Context budget check** — no task exceeds the 3-5 file limit
6. **TDD check** — every impl task has a preceding test task, and no test task references implementation that doesn't exist yet

Verification output goes to `/docs/features/$ARGUMENTS/plan-verification.md`.

If the verifier finds mismatches, fix the plan and re-verify.

## Checkpoint

Present the plan + verification report to the user for approval.

**This session ends after plan approval.** The user will start a new session for Phase 3.

## Rules

- Do NOT write implementation code — only the plan
- If you discover something that should change the PRD, escalate to the user
- Respect user preferences — only override them if technically impossible
- Every task must be completable by a single agent in a fresh 200k context window
- Test tasks describe WHAT to test (behavior), not HOW to implement
