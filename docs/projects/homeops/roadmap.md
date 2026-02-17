# Project Roadmap: HomeOps

Source PRD: `/docs/projects/homeops/prd.md`
Created: 2026-02-17

## Phases

| # | Name | Feature ID | Status | Depends On |
|---|------|------------|--------|------------|
| 1 | Infrastructure & Telegram Ingestion | homeops-p1-infra | done | — |
| 2 | Message Understanding & Activity Logging | homeops-p2-classification | done | Phase 1 |
| 3 | Memory System & Learning | homeops-p3-learning | pending | Phase 2 |
| 4 | Balance, Fairness & Dispute Resolution | homeops-p4-balance | pending | Phase 3 |
| 5 | Promise Engine & Proactive Behavior | homeops-p5-promises | pending | Phase 4 |
| 6 | DM Insights & Adaptive Intelligence | homeops-p6-insights | pending | Phase 5 |

Status values: pending | in-progress | done

## Phase 1: Infrastructure & Telegram Ingestion

- **Feature ID**: `homeops-p1-infra`
- **Goal**: Deploy the core AWS serverless stack and wire Telegram messages through the ingestion pipeline to persistent storage.
- **Delivers**: CDK-deployed stack (API Gateway, Lambda, SQS, DynamoDB) receiving Telegram webhook messages, dequeuing them, and storing raw messages. Health check endpoint.
- **PRD sections covered**: §20 Runtime Architecture, §21 Worker Model, §22 Infrastructure Stack, §23 Reliability Targets, §24 Security, §9.1 Group Chat webhook
- **Depends on**: —

## Phase 2: Message Understanding & Activity Logging

- **Feature ID**: `homeops-p2-classification`
- **Goal**: Classify natural Swedish messages as chore/recovery/none via OpenAI and log structured activity events.
- **Delivers**: Worker processes queued messages through OpenAI, classifies activities, stores typed events. Basic silence rules prevent unnecessary responses. Clarification questions when uncertain.
- **PRD sections covered**: §6 Activity Model, §8 Interaction Model, §10 Group Response Policy, §11 Silence Rules, §12 Clarification Policy, §14 Memory (events), §18 Intelligence Architecture (extraction step), §19 Tone Enforcement (basic), §25 Classification System
- **Depends on**: Phase 1 — ingestion pipeline, DynamoDB tables, Secrets Manager (OpenAI key)

## Phase 3: Memory System & Learning

- **Feature ID**: `homeops-p3-learning`
- **Goal**: Enable persistent learning across aliases, effort patterns, and user preferences so the agent improves over time.
- **Delivers**: Alias vocabulary mapping, EMA-based effort tracking per user+activity, preference learning (ignore rate, response timing), channel routing (group vs DM).
- **PRD sections covered**: §9.2 DM channel routing, §13 Learning System (all), §14 Memory System (full: language, behavior, pattern)
- **Depends on**: Phase 2 — classified activity events, message processing pipeline

## Phase 4: Balance, Fairness & Dispute Resolution

- **Feature ID**: `homeops-p4-balance`
- **Goal**: Calculate household balance, assess fairness with weighted metrics, and handle disputes by posting neutral factual logs.
- **Delivers**: NetLoad calculation per member, fairness engine using effort+recovery+patterns+history, recovery intelligence, dispute detection with factual log responses, tone enforcement validation.
- **PRD sections covered**: §7 Balance Algorithm, §19 Tone Enforcement (full), §26 Recovery Intelligence, §27 Fairness Engine, §28 Dispute Intelligence
- **Depends on**: Phase 3 — effort learning data, memory system with historical patterns

## Phase 5: Promise Engine & Proactive Behavior

- **Feature ID**: `homeops-p5-promises`
- **Goal**: Detect promises from natural language, schedule reminders, and enable the planner engine for autonomous interventions within budget.
- **Delivers**: Promise detection from Swedish text, promise storage and lifecycle, EventBridge-scheduled reminders, follow-up checks, planner engine (periodic state evaluation), proactivity budget enforcement.
- **PRD sections covered**: §15 Planner Engine, §16 Proactive Behavior (promises, recurring, disputes), §17 Proactivity Budget, §29 Promise Engine
- **Depends on**: Phase 4 — balance data for planner decisions, tone enforcement for outputs

## Phase 6: DM Insights & Adaptive Intelligence

- **Feature ID**: `homeops-p6-insights`
- **Goal**: Deliver private weekly insights via DM, collect ratings, and close the full adaptation feedback loop.
- **Delivers**: Weekly private insight generation, personal summaries, DM rating/preference collection, full behavioral adaptation loop, intelligence metrics tracking.
- **PRD sections covered**: §9.2 DM features (insights, summaries, ratings, preferences), §16 Proactive Behavior (weekly insights), §30 Metrics of Intelligence, §32 Failure Conditions (system-level validation)
- **Depends on**: Phase 5 — planner engine, proactivity budget for DM outputs
