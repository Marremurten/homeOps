# Scope Brief: Balance, Fairness & Dispute Resolution

Project: HomeOps
Phase: 4 of 6
Feature ID: homeops-p4-balance
Roadmap: `/docs/projects/homeops/roadmap.md`

## Goal

Calculate household balance, assess fairness with weighted metrics, and handle disputes by posting neutral factual logs.

## In Scope

- **Balance Algorithm** (§7): Calculate `NetLoad = Effort - Recovery` per household member. Calculate household balance as difference between members' net loads. Present results neutrally.
- **Fairness Engine** (§27): Weighted fairness assessment based on effort, recovery, patterns, and history — not raw counts. Consider time-weighted contributions and activity difficulty.
- **Recovery Intelligence** (§26): When a member's load is high, suppress reminders and soften tone. Allow pause suggestions.
- **Dispute Intelligence** (§28): Detect disagreement in conversation. Respond with factual log only — no opinions, no sides.
- **Tone Enforcement — Full** (§19): Complete tone validation on all outgoing messages. Messages must never contain blame, comparison, commands, or judgment. Fallback template required for edge cases.

## Out of Scope

- Promise detection (→ Phase 5)
- Planner engine (→ Phase 5)
- Proactive behavior / scheduled interventions (→ Phase 5)
- Proactivity budget (→ Phase 5)
- DM insight generation (→ Phase 6)
- Weekly summaries (→ Phase 6)

## Prior Phases (what's already built)

- Phase 1 built: AWS CDK stack, Telegram webhook, message ingestion pipeline, DynamoDB, Secrets Manager
- Phase 2 built: OpenAI classification (chore/recovery/none), activity event logging, silence rules, clarification system, group response policy, basic tone enforcement
- Phase 3 built: Alias learning, EMA effort tracking per user+activity, preference learning, full memory system (events, language, behavior, patterns), channel routing (group vs DM), memory queries

## Success Criteria

- [ ] NetLoad calculated correctly per household member (Effort - Recovery)
- [ ] Household balance computed as difference between members' net loads
- [ ] Balance presented neutrally — no framing that implies one member is "better" or "worse"
- [ ] Fairness engine weights effort, recovery, patterns, and history — not raw event counts
- [ ] Recovery intelligence suppresses reminders when a member's load is high
- [ ] Recovery intelligence softens tone for high-load members
- [ ] Dispute detected when conversation contains disagreement about household contributions
- [ ] Dispute response contains only factual log entries — no opinions, blame, or sides
- [ ] All outgoing messages pass tone validation (no blame, comparison, commands, judgment)
- [ ] Fallback template used when tone validation fails on generated text

## Constraints

- Balance must never be presented as a competition or ranking
- Fairness weights should be configurable but ship with sensible defaults
- Dispute detection must have high precision — false positives are worse than missed disputes
- Recovery intelligence must not reveal one member's load to another (privacy)

## Suggested Research Areas

1. Neutral language patterns for presenting balance data — how to show differences without implied judgment
2. Dispute detection in conversational Swedish — linguistic signals for disagreement vs normal discussion
3. Fairness weighting strategies — time decay, activity difficulty normalization, recovery credit approaches
4. Tone validation techniques — rule-based vs LLM-based checking of outgoing messages
