# Scope Brief: Memory System & Learning

Project: HomeOps
Phase: 3 of 6
Feature ID: homeops-p3-learning
Roadmap: `/docs/projects/homeops/roadmap.md`

## Goal

Enable persistent learning across aliases, effort patterns, and user preferences so the agent improves over time.

## In Scope

- **Alias Learning** (§13.2): Learn household vocabulary mappings (e.g., "pant" → recycling). Store in DynamoDB. Use learned aliases in future classification.
- **Effort Learning** (§13.1): Exponential Moving Average (EMA) per user + activity type. Track perceived effort over time. Update after each classified event.
- **Preference Learning** (§13.3): Track per-user ignore rate, response timing preferences, interaction frequency. Adjust response behavior accordingly (e.g., reduce output for users who ignore messages).
- **Memory System — Full** (§14): Complete all four memory types:
  - Event logs (already from Phase 2)
  - Language aliases (new)
  - Behavior preferences (new)
  - Pattern habits (new)
- **Channel Routing** (§9.2): Differentiate group chat vs DM messages. Route DM-appropriate interactions (ratings, preferences) to DM channel. Maintain group chat as passive observer.
- **Memory Queries**: Support "who did X last?" style lookups against event history.

## Out of Scope

- Balance algorithm (→ Phase 4)
- Fairness engine (→ Phase 4)
- Recovery intelligence (→ Phase 4)
- Dispute detection (→ Phase 4)
- Full tone enforcement (→ Phase 4)
- Promise engine (→ Phase 5)
- Planner engine (→ Phase 5)
- Proactive behavior (→ Phase 5)
- DM insight generation (→ Phase 6)
- DM summaries and ratings UI (→ Phase 6)

## Prior Phases (what's already built)

- Phase 1 built: AWS CDK stack, Telegram webhook, message ingestion pipeline (API Gateway → SQS → Worker → DynamoDB), Secrets Manager
- Phase 2 built: OpenAI classification (chore/recovery/none), activity event logging, silence rules, clarification system, group response policy, basic tone enforcement, Telegram response sending

## Success Criteria

- [ ] Alias mappings stored in DynamoDB and used to improve future classification accuracy
- [ ] New aliases learned from clarification responses (user confirms "pant" means recycling → stored)
- [ ] EMA effort scores calculated per user + activity type and updated after each event
- [ ] Preference data tracked: per-user ignore rate, response timing, interaction frequency
- [ ] Agent adjusts behavior based on preferences (e.g., reduces output frequency for users with high ignore rate)
- [ ] All four memory types (events, language, behavior, patterns) are persisted and queryable
- [ ] "Who did X last?" queries return correct results from event history
- [ ] Group vs DM messages routed correctly — group remains passive, DM allows direct interaction
- [ ] All memory records are timestamped and auditable

## Constraints

- DynamoDB as datastore — design for efficient query patterns
- EMA smoothing factor should be configurable
- Alias learning must not override explicit corrections
- Preference adaptation must be gradual — no sudden behavioral changes from a single interaction

## Suggested Research Areas

1. EMA implementation for effort tracking — smoothing factor selection, cold-start handling for new users/activities
2. DynamoDB design for alias lookup — fast reads for classification-time vocabulary resolution
3. Preference learning algorithms — how to balance responsiveness to user behavior changes vs stability
4. Telegram Bot API for DM interactions — initiating private conversations, permissions model
