# Scope Brief: Message Understanding & Activity Logging

Project: HomeOps
Phase: 2 of 6
Feature ID: homeops-p2-classification
Roadmap: `/docs/projects/homeops/roadmap.md`

## Goal

Classify natural Swedish messages as chore/recovery/none via OpenAI and log structured activity events.

## In Scope

- **Activity Model** (§6): Define chore and recovery activity types with structured schema
- **OpenAI Integration** (§18, §25): Call OpenAI chat completions API from Worker Lambda to extract meaning from Swedish messages
- **Classification System** (§25): Classify every message as `chore | recovery | none` with confidence score
- **Activity Event Logging** (§14 events): Store classified activities in DynamoDB with user, type, activity name, effort estimate, timestamp
- **Interaction Model** (§8): Handle natural Swedish input — no commands required
- **Group Response Policy** (§10): Only respond when confidence ≥ 0.85, directly addressed, dispute detected, or promise detected. Enforce output limits (≤1 line, neutral tone, ≤1 emoji, ≤3/day)
- **Silence Rules** (§11): Suppress output when uncertain, conversation is fast, topic irrelevant, recent output, or outside hours
- **Clarification Policy** (§12): Ask ≤5 word clarification questions when classification is uncertain (e.g., "Menade du tvatt?")
- **Tone Enforcement — Basic** (§19): No blame, comparison, commands, or judgment in any output. Fallback template for safe responses.
- **Telegram Response** (§20): Send replies back through Telegram Bot API when response policy allows

## Out of Scope

- Alias learning / vocabulary mapping (→ Phase 3)
- Effort learning / EMA (→ Phase 3)
- Preference learning (→ Phase 3)
- DM channel routing (→ Phase 3)
- Balance calculation (→ Phase 4)
- Fairness engine (→ Phase 4)
- Dispute intelligence (→ Phase 4)
- Recovery intelligence behavior modification (→ Phase 4)
- Promise detection (→ Phase 5)
- Planner engine (→ Phase 5)
- Proactive behavior (→ Phase 5)
- DM insights (→ Phase 6)

## Prior Phases (what's already built)

- Phase 1 built: AWS CDK stack with API Gateway, Ingest Lambda, SQS queue, Worker Lambda, DynamoDB tables, Secrets Manager (Telegram token + OpenAI key), CloudWatch logging

## Success Criteria

- [ ] Worker Lambda calls OpenAI to classify Swedish messages
- [ ] Messages classified as chore, recovery, or none with confidence score
- [ ] Classified activities stored in DynamoDB with structured schema (user, type, activity, effort, timestamp)
- [ ] Agent stays silent for messages classified as `none`
- [ ] Agent stays silent when confidence < 0.85
- [ ] Clarification question sent when classification is uncertain but promising (≤5 words)
- [ ] Output respects limits: ≤1 line, neutral tone, ≤1 emoji, ≤3 responses/day
- [ ] No responses contain blame, comparison, commands, or judgment
- [ ] Silence enforced when conversation is fast-moving, topic irrelevant, or recent output exists
- [ ] Telegram Bot API used to send responses back to the group chat

## Constraints

- OpenAI API (not Anthropic) per PRD spec
- All prompts in English (system language), user messages in Swedish
- Precision over recall — missing an event is better than interrupting incorrectly
- Response frequency hard-capped at ≤3/day per group

## Suggested Research Areas

1. OpenAI prompt engineering for Swedish household activity classification — structured output, confidence scoring, and few-shot examples
2. Telegram Bot API for sending messages — reply formatting, rate limits, and bot permissions in group chats
3. DynamoDB schema design for activity events — query patterns for "who did what last" and time-range queries
4. Rate limiting patterns in Lambda — tracking daily response count per chat without race conditions
