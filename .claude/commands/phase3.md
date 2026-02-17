# Phase 3: Implement — $ARGUMENTS

You are starting **Phase 3 (Implementation)** for feature: **$ARGUMENTS**

This phase uses **test-driven development (TDD)**. Tests are written by one agent, implementation by another. The implementer's only goal is to make the tests pass.

## Step 1: Read input

Read `/docs/features/$ARGUMENTS/plan.md` — this is the ONLY input for this phase.

Do NOT re-read research files — the plan already incorporates them.

## Step 2: Create the team

You are the **team lead**. Create a team for this feature:

```
TeamCreate: team_name = "impl-$ARGUMENTS"
```

Then create tasks in the shared task list using `TaskCreate` — one task per **Implementation Task** from the plan (both test and impl tasks). Include:

- The task type (test or impl)
- The task description from the plan
- The exact files to create/modify
- Dependencies (use `TaskUpdate` with `addBlockedBy` matching the plan's dependencies)

## Step 3: Wave execution

Execute waves in order from the plan. For each wave:

1. **Check the task list** — identify tasks whose `blockedBy` dependencies are all completed
2. **Spawn one teammate per ready task** (max 4 parallel per wave)
3. **Wait for teammates to complete** — they will message you on completion or blockers
4. **Between waves**:
   - Run `TaskList` to verify wave completion
   - Check `/docs/features/$ARGUMENTS/blockers/` for any blocker files
   - If blockers exist, present them to the user and wait for guidance
   - If no blockers, announce wave completion and proceed
   - **Git commit** the wave's changes (see Git Strategy below)

### Spawning teammates

Spawn teammates using the `Task` tool with `team_name: "impl-$ARGUMENTS"`:

- For **test tasks**: use `subagent_type: "test-writer"`
- For **impl tasks**: use the appropriate agent type from `.claude/agents/` (e.g., `backend-dev`, `frontend-dev`) based on the files involved. Fall back to `general-purpose` if no specific agent fits.
- Give each teammate a descriptive `name` (e.g., `test-orgs-migration`, `impl-orgs-middleware`)
- Use `run_in_background: true`

### Each teammate's prompt must contain ONLY:

- Their assigned task ID to claim via `TaskUpdate`
- The task description from the plan
- The exact files to create/modify
- Any relevant API contracts or DB schema from the plan (copy the relevant section)
- **Do NOT send the full plan** — only the task's section plus context it needs

### Test agent instructions (include in prompt for test tasks):

```
You are a TEST WRITER on team "impl-$ARGUMENTS".

1. Claim your task: TaskUpdate(taskId, status: "in_progress", owner: "<your-name>")
2. Write tests based on the task description — test BEHAVIOR, not implementation details
3. Tests MUST fail when run (there is no implementation yet) — that's expected
4. Verify tests fail for the RIGHT reason (missing function/module, not syntax errors)
5. Only create/modify files listed in your task
6. When done: TaskUpdate(taskId, status: "completed")
7. If blocked: message the lead with a short description (5 lines max),
   write details to /docs/features/$ARGUMENTS/blockers/<task-number>.md
8. Do NOT message unless you have a result, blocker, or question
```

### Implementation agent instructions (include in prompt for impl tasks):

```
You are an IMPLEMENTER on team "impl-$ARGUMENTS".

1. Claim your task: TaskUpdate(taskId, status: "in_progress", owner: "<your-name>")
2. Read the test file(s) FIRST — understand what the tests expect
3. Write the minimum code needed to make ALL tests pass
4. Run the tests and iterate until they are GREEN
5. Do NOT modify the test files — only touch files listed in your task
6. Only touch files listed in your task
7. When done: TaskUpdate(taskId, status: "completed")
8. If blocked: message the lead with a short description (5 lines max),
   write details to /docs/features/$ARGUMENTS/blockers/<task-number>.md
9. Do NOT message unless you have a result, blocker, or question
```

## Step 4: Error recovery

If a teammate fails (tests don't pass, agent exhausts context, or reports a blocker):

1. **First retry**: Spawn a fresh agent for the same task with the same instructions. The fresh agent gets a clean 200k context. Add a note: "A previous agent attempted this task but did not succeed. Read the current state of the files and continue from where they left off."
2. **Second retry**: Spawn a fresh agent with modified instructions based on what went wrong. Include the blocker details from `/docs/features/$ARGUMENTS/blockers/<task-number>.md` in the prompt.
3. **After 2 failed retries**: Escalate to the user. Present:
   - What the task is trying to do
   - What went wrong in each attempt
   - The blocker file contents
   - Ask for guidance: simplify the task, change the approach, or manual intervention

Do NOT retry more than twice — escalate instead.

## Step 5: Git strategy

Commit after each completed wave:

```
git add <files from completed wave tasks>
git commit -m "feat($ARGUMENTS): wave N — <brief description>"
```

This gives you rollback points if something goes wrong in a later wave. The commit message should reference the wave number and summarize what was built.

After the final wave, do NOT squash — keep the wave-by-wave history for traceability.

## Step 6: Final verification

After all waves complete:

1. Run the full test suite
2. If tests fail, identify which task's code is failing and follow the error recovery protocol (Step 4)
3. Once all tests pass, announce completion

## Step 7: Teardown

1. Send `shutdown_request` to all teammates
2. After all teammates confirm shutdown, run `TeamDelete`

## Checkpoint

Confirm all tests pass, then ask the user if ready for verification.

**This session ends after all tests pass.** The user will start a new session for Phase 4.

## Rules

- Do NOT expand scope beyond the plan
- Do NOT send the full plan to teammates — only their specific task
- Each teammate gets a fresh context — never assume a teammate knows what a previous one did
- If a teammate needs output from a previous task (e.g., a type definition), tell it which file to read — don't paste the content
- Maximum 4 parallel teammates per wave
- Use the task list as the source of truth for progress — check it between waves
- Follow the teammate message discipline: 5 lines max, details go in files
- **TDD is non-negotiable**: test agents NEVER see implementation, impl agents NEVER modify tests
- Maximum 2 retries per task before escalating to user
