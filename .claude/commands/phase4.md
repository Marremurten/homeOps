# Phase 4: Verify — $ARGUMENTS

You are starting **Phase 4 (Verification)** for feature: **$ARGUMENTS**

## Step 1: Read inputs

Read these files (and ONLY these):

- `/docs/features/$ARGUMENTS/prd.md`
- `/docs/features/$ARGUMENTS/plan.md`

Do NOT read individual research files or implementation code yet — the reviewers will do that.

## Step 2: Create the team

You are the **team lead**. Create a verification team:

```
TeamCreate: team_name = "verify-$ARGUMENTS"
```

## Step 3: Spawn reviewers

Create tasks in the shared task list using `TaskCreate`, then spawn reviewers:

### 1. Code Reviewer (`subagent_type: "code-reviewer"`)

- Name: `code-reviewer`
- Task: Review all implementation code for quality, consistency, and pattern compliance
- Reads: PRD, plan, all implementation files listed in the plan
- Writes: `/docs/features/$ARGUMENTS/verify/code-review.md`

### 2. Security Reviewer (`subagent_type: "security-reviewer"`)

- Name: `security-reviewer`
- Task: Check for OWASP Top 10 vulnerabilities, auth/authz issues, input validation
- Reads: PRD, plan, all implementation files listed in the plan
- Writes: `/docs/features/$ARGUMENTS/verify/security.md`

### 3. Integration Tester (`subagent_type: "integration-tester"`)

- Name: `integration-tester`
- Task: Run full test suite, verify PRD success criteria are covered, write additional integration tests if gaps exist
- Reads: PRD, plan, runs tests
- Writes: `/docs/features/$ARGUMENTS/verify/integration.md`

Spawn all three with `run_in_background: true` and `team_name: "verify-$ARGUMENTS"`.

Each reviewer's prompt must include:

- Their task ID to claim via `TaskUpdate`
- The feature name for correct file paths
- The list of implementation files from the plan (so they know what to review)

### Reviewer instructions (include in prompt):

```
You are a REVIEWER on team "verify-$ARGUMENTS".

1. Claim your task: TaskUpdate(taskId, status: "in_progress", owner: "<your-name>")
2. Read the PRD at /docs/features/$ARGUMENTS/prd.md
3. Read the plan at /docs/features/$ARGUMENTS/plan.md
4. Perform your review and write findings to your assigned output file
5. When done: TaskUpdate(taskId, status: "completed")
6. Message the lead with a 5-line summary of your findings
```

## Step 4: Synthesize results

After all reviewers complete:

1. Read the three verification files:
   - `/docs/features/$ARGUMENTS/verify/code-review.md`
   - `/docs/features/$ARGUMENTS/verify/security.md`
   - `/docs/features/$ARGUMENTS/verify/integration.md`
2. Write a consolidated report to `/docs/features/$ARGUMENTS/verify/report.md`

## Step 5: Teardown

1. Send `shutdown_request` to all reviewers
2. After all confirm shutdown, run `TeamDelete`

## Checkpoint

Present the consolidated verification report to the user with:

- **Overall assessment**: ship / ship with fixes / needs rework
- **Critical issues** that must be fixed before shipping
- **Security findings** with severity ratings
- **Test coverage** — which PRD success criteria are verified, which aren't
- **Scope check** — was anything built that wasn't in the PRD?
- **Suggestions** for improvement (non-blocking)

If the assessment is "ship with fixes", list the specific fixes needed. The user decides whether to fix now or defer.

## Step 6: Update roadmap (if applicable)

Check if this feature is part of a decomposed project by looking for a `scope-brief.md` in `/docs/features/$ARGUMENTS/`:

- **If it exists**: Read the scope brief to find the project name and roadmap path. Update the roadmap at `/docs/projects/<project>/roadmap.md` — set this phase's status to `done`. Then tell the user which phase is next.
- **If it doesn't exist**: Skip this step.

**This session ends after presenting the report.** The feature workflow is complete.

## Rules

- Reviewers do NOT modify implementation code — only flag issues
- Every finding must reference specific file paths and line numbers
- Distinguish between blocking issues and suggestions
- The PRD is the source of truth for what should have been built
- If reviewers find scope creep (code not in the PRD), flag it clearly
