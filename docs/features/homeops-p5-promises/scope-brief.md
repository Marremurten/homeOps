# Scope Brief: Promise Engine & Proactive Behavior

Project: HomeOps
Phase: 5 of 6
Feature ID: homeops-p5-promises
Roadmap: `/docs/projects/homeops/roadmap.md`

## Goal

Detect promises from natural language, schedule reminders, and enable the planner engine for autonomous interventions within budget.

## In Scope

- **Promise Engine** (§29): Detect statements implying responsibility (e.g., "Jag tar disken sen"). Store promises with user, activity, timestamp, and expected completion. Track promise lifecycle (open → reminded → fulfilled/expired).
- **Scheduled Reminders**: Use EventBridge to schedule reminder events. Worker Lambda processes reminder events and sends follow-up messages.
- **Follow-up Checks**: After a reminder, check if the promise was fulfilled (matching activity event logged). Close fulfilled promises silently.
- **Planner Engine** (§15): Periodic state evaluation considering activity history, promises, patterns, load balance, and signals. Outputs action OR none. Prefers silence over low-value action.
- **Proactive Behavior** (§16): Autonomous actions for overdue promises, missed recurring activities, and dispute facts. (Weekly insights → Phase 6)
- **Proactivity Budget** (§17): Enforce limits — ≤1/day proactive in group, ≤2/week in DM, 1 follow-up per promise. Ignored outputs reduce future frequency.

## Out of Scope

- Weekly private insights (→ Phase 6)
- DM insight generation (→ Phase 6)
- Personal summaries (→ Phase 6)
- Rating collection (→ Phase 6)
- Full adaptive feedback loop (→ Phase 6)

## Prior Phases (what's already built)

- Phase 1 built: AWS CDK stack, Telegram webhook, message ingestion pipeline, DynamoDB, Secrets Manager
- Phase 2 built: OpenAI classification, activity event logging, silence rules, clarification system, group response policy, tone enforcement (basic)
- Phase 3 built: Alias learning, EMA effort tracking, preference learning, full memory system, channel routing, memory queries
- Phase 4 built: Balance algorithm (NetLoad), fairness engine, recovery intelligence, dispute intelligence, tone enforcement (full)

## Success Criteria

- [ ] Promises detected from natural Swedish (e.g., "Jag tar disken sen", "Jag fixar det imorgon")
- [ ] Promises stored with user, activity, timestamp, and expected completion time
- [ ] EventBridge rules created to trigger reminder events at appropriate times
- [ ] Reminder messages sent through Telegram when promises are overdue
- [ ] Fulfilled promises detected (matching activity logged) and closed silently
- [ ] Planner engine runs periodically and evaluates system state
- [ ] Planner prefers silence — only triggers action when value is high
- [ ] Proactive messages sent for overdue promises and missed recurring activities
- [ ] Group proactivity capped at ≤1/day
- [ ] DM proactivity capped at ≤2/week
- [ ] Follow-ups limited to 1 per promise
- [ ] Ignored outputs reduce future proactivity frequency

## Constraints

- EventBridge for all scheduling (no cron in Lambda)
- Promise detection must have high precision — false promises are disruptive
- Reminder tone must be neutral and non-nagging
- Proactivity budget is a hard cap, not a target
- Planner engine must be stateless (reads from DB each evaluation)

## Suggested Research Areas

1. Promise detection in conversational Swedish — linguistic patterns for commitments, temporal expressions ("sen", "imorgon", "ikväll")
2. EventBridge scheduling patterns — dynamic rule creation from Lambda, cleanup of expired rules
3. Planner engine design — evaluation criteria, scoring functions for action vs silence decision
4. Proactivity budget tracking — DynamoDB counters with time-window resets, handling ignored output feedback
