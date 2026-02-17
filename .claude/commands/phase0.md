# Phase 0: Scope — $ARGUMENTS

You are starting **Phase 0 (Scope)** for feature: **$ARGUMENTS**

## Step 0: Check for scope brief

Check if `/docs/features/$ARGUMENTS/scope-brief.md` exists:

- **If it exists**: This feature is part of a decomposed project. Read the scope brief — it contains the goal, in-scope capabilities, out-of-scope items, prior phase context, success criteria, and suggested research areas. Use it as your starting point instead of asking from scratch. Confirm with the user that the scope brief is still accurate, then refine it into a full PRD.
- **If it doesn't exist**: Proceed normally — ask the user questions from scratch.

## What to do

1. Ask the user questions to understand intent, constraints, and priorities (skip questions already answered by the scope brief)
2. Create the directory `/docs/features/$ARGUMENTS/` (if it doesn't already exist)
3. Write `prd.md` using the template at `/docs/templates/prd-template.md`
4. The PRD must define:
   - What is IN scope (with success criteria)
   - What is explicitly OUT of scope
   - Constraints
   - Suggested research areas (2-4 specific angles the research phase should investigate)
5. If the feature is large and there is NO scope brief, propose splitting into child features (`$ARGUMENTS-part-1`, `$ARGUMENTS-part-2`, etc.). If there IS a scope brief, trust the decomposition — the splitting was already done.

## Checkpoint

Get user approval on the PRD before ending.

**This session ends after PRD approval.** The user will start a new session for Phase 1.

## Rules

- Do NOT start researching or planning — only scoping
- Do NOT create any implementation code
- Ask questions until the scope is clear — don't assume
