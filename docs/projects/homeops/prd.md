# Product Requirements Document (PRD) — HomeOps

**Version:** 1.0
**Product Type:** Intelligent Household Equilibrium Agent
**Primary Interface:** Telegram
**System Language:** English
**User Language:** Swedish
**Architecture:** Event-Driven Agent Runtime
**Deployment:** AWS Serverless (CDK)
**LLM Provider:** OpenAI

## 1. Executive Summary

HomeOps is a passive, adaptive household intelligence agent that lives inside a normal chat and quietly tracks contributions, recovery activities, promises, and patterns. It intervenes rarely and only when useful.

It does not manage tasks.
It maintains balance, memory, and fairness.

## 2. Product Vision

A silent system that understands effort, remembers reality, and preserves harmony.

## 3. Problem Statement

Household friction arises from:

- invisible labor
- forgotten effort
- uneven responsibility
- subjective perception
- memory disputes
- coordination overhead

Existing tools fail because they require structure, discipline, or explicit input.

HomeOps works inside natural conversation instead.

## 4. Design Principles

### 4.1 Silence First
Agent speaks only when useful.

### 4.2 Subjective Truth
Effort is self-perceived, not objective.

### 4.3 Neutrality
Agent never judges or compares.

### 4.4 Precision Over Recall
Missing an event is better than interrupting incorrectly.

### 4.5 Human Priority
Conversation always outranks automation.

## 5. Target Users

Small households (2-5 people) who:

- coordinate via chat
- share responsibilities
- value fairness
- dislike admin tools

## 6. Activity Model

HomeOps tracks two types of activities.

### 6.1 Chore
Any action contributing to household functioning.

Examples: cleaning, childcare, errands, planning, logistics

### 6.2 Recovery (Anti-Chore)
Any action restoring energy.

Examples: rest, hobbies, social time, exercise, alone time

**Definition:** Recovery is a user-perceived energy-positive activity.

## 7. Balance Algorithm (Core Logic)

```
NetLoad = Effort - Recovery
```

Household balance:
```
Balance = difference between members' net load
```

System must present results neutrally.

## 8. Interaction Model

Users speak naturally. No commands required.

Examples:
- "Jag tog tvatten"
- "Jag fixade koket"
- "Jag kan ta disken sen"
- "Jag var pa AW"

## 9. Channel Architecture

### 9.1 Group Chat - Primary Interface
Used for normal conversation. Agent role: passive observer.

### 9.2 Direct Messages
Used for: ratings, insights, summaries, preferences, reminders

## 10. Group Response Policy

Agent may respond only when:
- confidence >= 0.85
- directly addressed
- dispute detected
- promise detected
- scheduled reminder

| Property  | Limit     |
|-----------|-----------|
| Length    | <=1 line  |
| Tone     | neutral   |
| Emoji    | <=1       |
| Frequency| <=3/day   |

## 11. Silence Rules

Agent must remain silent when:
- uncertain
- conversation fast
- topic irrelevant
- recent output
- outside hours

Silence is a feature.

## 12. Clarification Policy

Allowed format: `Menade du tvatt?`

Maximum: 5 words.

## 13. Learning System

HomeOps learns continuously.

### 13.1 Effort Learning
EMA per user + activity.

### 13.2 Alias Learning
Learns household vocabulary. Example: "pant" -> recycling

### 13.3 Preference Learning
Tracks: ignore rate, response timing, interaction frequency. Adjusts behavior accordingly.

## 14. Memory System

Persistent memory types:

| Type     | Description  |
|----------|-------------|
| Event    | logs        |
| Language | aliases     |
| Behavior | preferences |
| Pattern  | habits      |

All records timestamped and auditable.

## 15. Planner Engine

Runs periodically and evaluates state.

**Input:** activity history, promises, patterns, load balance, signals

**Output:** action OR none

**Rule:** Prefer silence over low-value action.

## 16. Proactive Behavior

Allowed autonomous actions:
- overdue promises
- missed recurring activities
- dispute facts
- weekly private insights

## 17. Proactivity Budget

| Channel   | Limit          |
|-----------|----------------|
| Group     | <=1/day proactive |
| DM        | <=2/week       |
| Followups | 1              |

Ignored outputs reduce frequency.

## 18. Intelligence Architecture

Pipeline:
```
Message -> Extraction -> Learning -> Memory -> Planner -> Policy -> Action
```

## 19. Tone Enforcement

Messages must never contain: blame, comparison, commands, judgment.

Fallback template required.

## 20. Runtime Architecture

```
Telegram -> Ingest -> Queue -> Worker -> Tools -> DB
```

### Components
- **Ingest**: Receives external events.
- **Queue**: Buffers + retries.
- **Worker**: Processes logic.

## 21. Worker Model

Initial deployment uses one worker. Architecture must support scaling to multiple workers later.

## 22. Infrastructure Stack

AWS:
- API Gateway
- Lambda
- SQS
- DynamoDB/Postgres
- EventBridge
- CloudWatch
- Secrets Manager

## 23. Reliability Targets

| Metric         | Target  |
|----------------|---------|
| Latency        | <2s     |
| Duplicate logs | <1%     |
| Downtime       | <0.1%   |

## 24. Security

- encrypted storage
- least privilege IAM
- secure secrets
- minimal retention

## 25. Classification System

Every detected action classified: `chore | recovery | none`

If uncertain -> ask and learn.

## 26. Recovery Intelligence

Recovery affects system behavior:
- suppress reminders if load high
- soften tone
- allow pause suggestions

## 27. Fairness Engine

Fairness based on: effort, recovery, patterns, history. Not raw counts.

## 28. Dispute Intelligence

When disagreement detected: Agent posts factual log only.

## 29. Promise Engine

Statements implying responsibility create promises.

Example: "Jag tar disken sen"

Triggers:
- promise stored
- reminder scheduled
- follow-up check

## 30. Metrics of Intelligence

Success signals:
- fewer clarifications
- fewer corrections
- fewer ignored messages
- higher trust

## 31. Rollout Phases

1. Logging
2. Learning
3. Insights
4. Proactivity
5. Prediction

## 32. Failure Conditions

Critical failures:
- unnecessary interruptions
- wrong logs
- comparisons
- excessive output
- acting while unsure

## 33. Product Category

HomeOps is **not**: task manager, productivity tool, tracker.

HomeOps **is**: a household intelligence system.

## 34. User Stories

- **Logging**: As a user, I want to say what I did naturally so I don't need commands.
- **Clarification**: As a user, I want the agent to ask only when necessary.
- **Memory**: As a user, I want to ask who did something last to avoid arguments.
- **Promise Tracking**: As a user, I want commitments remembered automatically.
- **Recovery**: As a user, I want restorative activities counted as balance.
- **Adaptation**: As a user, I want the agent to adjust to my behavior over time.
- **Silence**: As a user, I want the agent to stay quiet during normal conversation.
- **Trust**: As a user, I want to rely on the agent's memory.

## 35. Intelligence Definition

The system is intelligent when it: understands language, learns behavior, adapts output, times interventions, remembers correctly.

## 36. Design Law

The most intelligent agent is the one that knows when not to act.

## 37. Success Criteria

Product is successful when users: trust it, rely on it, forget it exists, stop arguing about chores.

## 38. Final Acceptance Test

The product passes when users say: "Den fattar."

---

**Final Definition**

HomeOps - A quiet system that understands effort, learns your life, and preserves balance.
