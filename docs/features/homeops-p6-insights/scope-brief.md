# Scope Brief: DM Insights & Adaptive Intelligence

Project: HomeOps
Phase: 6 of 6
Feature ID: homeops-p6-insights
Roadmap: `/docs/projects/homeops/roadmap.md`

## Goal

Deliver private weekly insights via DM, collect ratings, and close the full adaptation feedback loop.

## In Scope

- **Weekly Private Insights** (§16): Generate personalized weekly insights per household member. Deliver via DM. Cover effort summary, balance trends, and patterns.
- **Personal Summaries** (§9.2): On-demand and scheduled summaries of a member's contributions, recovery, and balance sent via DM.
- **DM Rating Collection** (§9.2): Allow users to rate activities for perceived effort via DM. Ratings feed back into effort learning.
- **DM Preference Collection** (§9.2): Allow users to adjust preferences (notification timing, sensitivity) via DM.
- **Full Behavioral Adaptation Loop**: Close the loop — preference learning (Phase 3) + rating data → adjusted classification weights, response frequency, and tone.
- **Intelligence Metrics** (§30): Track system-level success signals — fewer clarifications over time, fewer corrections, fewer ignored messages, higher trust (measured by engagement).
- **Failure Condition Validation** (§32): System-level checks that the agent does not: interrupt unnecessarily, log incorrectly, make comparisons, produce excessive output, or act while unsure.

## Out of Scope

All core functionality is built in prior phases. This phase focuses on the DM intelligence layer and closing the feedback loop.

## Prior Phases (what's already built)

- Phase 1 built: AWS CDK stack, Telegram webhook, message ingestion pipeline, DynamoDB, Secrets Manager
- Phase 2 built: OpenAI classification, activity event logging, silence rules, clarification system, group response policy, tone enforcement (basic)
- Phase 3 built: Alias learning, EMA effort tracking, preference learning, full memory system, channel routing, memory queries
- Phase 4 built: Balance algorithm, fairness engine, recovery intelligence, dispute intelligence, tone enforcement (full)
- Phase 5 built: Promise engine, scheduled reminders (EventBridge), follow-up checks, planner engine, proactive behavior, proactivity budget

## Success Criteria

- [ ] Weekly insight messages generated per household member
- [ ] Insights delivered via Telegram DM on a configurable schedule
- [ ] Insights include: effort summary, balance trend, notable patterns
- [ ] Insights respect tone enforcement — no blame, comparison, or judgment
- [ ] Personal summaries available on-demand via DM
- [ ] Users can rate activity effort via DM interaction
- [ ] Ratings feed back into EMA effort learning
- [ ] Users can adjust preferences (notification timing, sensitivity) via DM
- [ ] Preference changes reflected in agent behavior within next evaluation cycle
- [ ] Intelligence metrics tracked: clarification rate, correction rate, ignore rate, engagement rate
- [ ] Metrics trend in the right direction over time (fewer clarifications, fewer corrections)
- [ ] System does not exhibit failure conditions: unnecessary interruptions, wrong logs, comparisons, excessive output, acting while unsure

## Constraints

- DM insights must respect proactivity budget (≤2/week per DM)
- Insights must be private — never share one member's data with another
- Rating collection must be simple — no complex UI, just conversational
- Metrics are internal system health indicators, not exposed to users
- Adaptation must be gradual and stable

## Suggested Research Areas

1. Insight generation with OpenAI — summarizing weekly activity data into concise, neutral, useful personal insights in Swedish
2. Telegram DM interaction patterns — conversational rating collection without feeling like a survey
3. Intelligence metrics baseline and tracking — what's a good starting point, how to measure improvement
4. Feedback loop stability — preventing oscillation when ratings and preferences change adaptation parameters
