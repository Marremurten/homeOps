# Decompose: Project PRD into Implementation Phases — $ARGUMENTS

You are **decomposing** a full project PRD into ordered implementation phases for project: **$ARGUMENTS**

## Purpose

A full project PRD is too large for a single pass through the Phase 0-4 feature pipeline. This command breaks it into sequential phases where each phase:

- Is small enough for one agent team to implement (fits Phase 3 context budget)
- Produces a working, testable increment
- Goes through the standard Phase 0 → 1 → 2 → 3 → 4 pipeline independently

## Step 1: Read or create project PRD

Check if `/docs/projects/$ARGUMENTS/prd.md` exists:

- **If it exists**: Read it.
- **If it doesn't exist**: Ask the user to provide the project PRD. They can paste it, point to a file, or provide a URL. Create `/docs/projects/$ARGUMENTS/` and write the PRD to `/docs/projects/$ARGUMENTS/prd.md`.

Confirm with the user that the PRD is complete before proceeding.

## Step 2: Analyze the PRD

Identify all distinct capabilities in the PRD:

- **User-facing features** — what the end user can do
- **Infrastructure** — auth, DB schema, real-time, APIs, etc.
- **Integrations** — third-party services, external APIs
- **Cross-cutting concerns** — error handling, logging, permissions

For each capability, note:

- What it depends on (e.g., "task CRUD depends on DB schema and auth")
- What depends on it
- Whether it can be tested independently
- Rough complexity (S/M/L)

## Step 3: Group into ordered phases

Group capabilities into implementation phases. Each phase MUST:

1. **Build on previous phases only** — never depend on something not yet built
2. **Be independently testable** — produce a working increment that can be verified in Phase 4
3. **Fit the Phase 3 context budget** — target 4-8 TDD task pairs per phase (will be refined in Phase 2). If a phase feels larger, split it.
4. **Have a clear, single goal** — one sentence describing what this phase delivers

### Ordering principles

- **Foundation first**: DB schema, auth, core data models before feature work
- **Vertical slices preferred**: a thin end-to-end feature over a thick backend-only layer. Each phase should ideally touch DB → API → UI so the increment is user-visible.
- **Risk first**: tackle uncertain, complex, or novel parts early — don't defer hard problems
- **Dependencies before dependents**: strictly enforce

### Phase sizing guidance

- **Too small**: fewer than 3 task pairs → merge with an adjacent phase
- **Right size**: 4-8 task pairs → good for one Phase 3 session
- **Too large**: more than 10 task pairs → split into sub-phases
- When in doubt, err on the side of smaller phases — they're easier to manage

## Step 4: Checkpoint — present phase breakdown

Present the proposed breakdown to the user:

```
Project: $ARGUMENTS
Total phases: N

Phase 1: <name>
  Goal: <one sentence>
  Delivers: <what's built and testable after this phase>
  Depends on: — (foundation)
  PRD coverage: <which PRD capabilities/sections>
  Est. complexity: S/M/L

Phase 2: <name>
  Goal: <one sentence>
  Delivers: <what's new and testable>
  Depends on: Phase 1
  PRD coverage: <which PRD capabilities/sections>
  Est. complexity: S/M/L

...

Coverage check:
  Covered: <list all PRD capabilities and which phase handles each>
  Missing: <any PRD capabilities NOT assigned to a phase — must be zero>
```

**Wait for user approval.** The user may:

- Reorder phases
- Split a phase that seems too large
- Merge phases that are too small
- Adjust which capabilities go where
- Remove scope they don't want yet

Iterate until approved. The coverage check must show zero missing items.

## Step 5: Write the roadmap

Write `/docs/projects/$ARGUMENTS/roadmap.md`:

```md
# Project Roadmap: $ARGUMENTS

Source PRD: `/docs/projects/$ARGUMENTS/prd.md`
Created: <date>

## Phases

| # | Name | Feature ID | Status | Depends On |
|---|------|------------|--------|------------|
| 1 | <name> | <project>-p1-<slug> | pending | — |
| 2 | <name> | <project>-p2-<slug> | pending | Phase 1 |
| 3 | <name> | <project>-p3-<slug> | pending | Phase 2 |

Status values: pending | in-progress | done

## Phase 1: <name>

- **Feature ID**: `<project>-p1-<slug>`
- **Goal**: <one sentence>
- **Delivers**: <what's built and testable>
- **PRD sections covered**: <references>
- **Depends on**: —

## Phase 2: <name>

- **Feature ID**: `<project>-p2-<slug>`
- **Goal**: <one sentence>
- **Delivers**: <what's built and testable>
- **PRD sections covered**: <references>
- **Depends on**: Phase 1 — <what Phase 1 built that this phase uses>

...
```

## Step 6: Write scope briefs

For each phase, create the feature directory and write a scope brief:

`/docs/features/<feature-id>/scope-brief.md`

Where `<feature-id>` is the Feature ID from the roadmap (e.g., `myapp-p1-auth`).

Each scope brief contains:

```md
# Scope Brief: <Phase Name>

Project: $ARGUMENTS
Phase: N of M
Feature ID: <feature-id>
Roadmap: `/docs/projects/$ARGUMENTS/roadmap.md`

## Goal

<One sentence: what this phase delivers>

## In Scope

<Specific capabilities from the project PRD. Reference PRD section numbers/names.>

- <capability 1>
- <capability 2>
- ...

## Out of Scope

<Everything else from the project PRD — explicitly listed to prevent scope creep.>

- <capability NOT in this phase> (→ Phase N)
- ...

## Prior Phases (what's already built)

<What previous phases have delivered. Phase 0 uses this to understand the starting point.>

- Phase 1 built: <summary>
- Phase 2 built: <summary>
- (empty for the first phase)

## Success Criteria

<How to verify this phase works — maps to PRD requirements.>

- [ ] <testable criterion 1>
- [ ] <testable criterion 2>
- ...

## Constraints

<Inherited from project PRD plus any phase-specific constraints.>

## Suggested Research Areas

<2-4 specific technical questions for Phase 1 (Research) to investigate.>

1. <research question 1>
2. <research question 2>
```

## Step 7: Explain next steps

Tell the user:

```
Roadmap: /docs/projects/$ARGUMENTS/roadmap.md

To implement each phase, run the standard pipeline:

  Phase 1 (start here):
    /phase0 <feature-id>    ← refine scope brief into a feature PRD
    /phase1 <feature-id>    ← research
    /phase2 <feature-id>    ← technical plan
    /phase3 <feature-id>    ← implement
    /phase4 <feature-id>    ← verify → updates roadmap status

  Then move to Phase 2:
    /phase0 <feature-id>
    ...

Each phase builds on the previous. Phase 0 will use the scope brief
as its starting point instead of asking from scratch.
```

**This session ends after presenting next steps.**

## Rules

- Do NOT start researching or implementing — only decompose
- Each phase must be achievable in a single Phase 3 session (target 4-8 TDD task pairs)
- Every phase must produce a testable increment — no "setup only" phases without verifiable output
- The scope briefs are starting points, not final PRDs — Phase 0 refines them
- Every PRD capability must be assigned to exactly one phase — zero gaps, zero duplicates
- If the PRD is unclear about priorities or dependencies, ask the user — don't assume
- Feature IDs use the format: `<project>-p<N>-<short-slug>` (e.g., `taskapp-p1-auth`)
