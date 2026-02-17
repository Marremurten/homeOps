# Phase 1: Research — $ARGUMENTS

You are starting **Phase 1 (Research)** for feature: **$ARGUMENTS**

## Step 1: Read PRD

Read `/docs/features/$ARGUMENTS/prd.md` — this is the ONLY input for this phase.

## Step 2: Determine research angles

Based on the PRD, determine 3-5 research angles:

1. **Always include: Codebase analyst** — map integration points, current patterns, data flow, and risk areas relevant to this feature.
2. **Use the PRD's "Suggested Research Areas"** as starting points.
3. **Add or adjust angles** based on your judgment of what the PRD actually needs. Consider: domain-specific patterns, library evaluation, security implications, performance concerns, UX patterns, accessibility, data modeling, API design, etc.

## Step 3: Checkpoint — get user approval on research plan

Present the research angles to the user **before spawning any agents**. For each researcher, show:

- **Role name** (e.g., "Codebase analyst", "Auth patterns researcher")
- **Research question** — the specific prompt the agent will receive
- **Output file** — where it will write findings

Wait for user approval. The user may adjust angles, add constraints, or remove researchers.

## Step 4: Spawn researchers

After approval, spawn each researcher using `subagent_type: "researcher"` with `run_in_background: true`. Pass the approved research question as the prompt. Each researcher writes to `/docs/features/$ARGUMENTS/research/<topic>.md`.

For the codebase analyst, use `subagent_type: "Explore"` since it only needs read access.

## Step 5: Synthesize

After all researchers complete, spawn a **synthesis agent** (`subagent_type: "general-purpose"`) that:

1. Reads ALL files in `/docs/features/$ARGUMENTS/research/`
2. Identifies agreements, conflicts, and gaps across findings
3. Writes `/docs/features/$ARGUMENTS/research/SUMMARY.md` containing:
   - **Recommended approach** — the synthesized recommendation
   - **Key findings** — most important discoveries per research area
   - **Risks & mitigations** — what could go wrong and how to handle it
   - **Open decisions** — things that need a human call before planning
   - **Conflicts** — where researchers disagreed and what the trade-offs are

## Step 6: Present to user

Read the SUMMARY.md and present the research summary to the user. Highlight any open decisions that need their input.

**This session ends after presenting the summary.** The user will start a new session for Phase 2.

## Rules

- Stay within PRD scope — if something is out of scope, note it as "potential future scope"
- Do NOT write implementation code or a technical plan — only research
- Each researcher writes to its own file — no shared state between researchers
- The lead (you) should NOT read individual research files — only the synthesis SUMMARY.md
- Keep researcher prompts focused: one clear question per agent, not a laundry list
