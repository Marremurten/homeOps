# Researcher Agent Memory

## Project: HomeOps
- Household intelligence agent, Telegram-based, AWS serverless (CDK TypeScript)
- Region: eu-north-1
- 6-phase roadmap: Phase 1 = infra + ingestion, Phase 2 = classification, etc.
- PRD: `/docs/projects/homeops/prd.md`
- Roadmap: `/docs/projects/homeops/roadmap.md`
- Phase 1 PRD: `/docs/features/homeops-p1-infra/prd.md`

## Architecture (Phase 1)
- Telegram Bot API -> API Gateway -> Ingest Lambda -> SQS -> Worker Lambda -> DynamoDB
- DynamoDB table: `messages` (PK: chatId, SK: messageId)
- Low throughput: 50-200 messages/day

## Key Decisions
- Standard SQS queue (not FIFO) - app-level idempotency via DynamoDB conditional writes
  - See: `/docs/features/homeops-p1-infra/research/sqs-configuration.md`
- DynamoDB hybrid design: `homeops-messages` (Phase 1) + `homeops` single-table (Phase 2+)
  - Messages table: chatId PK, messageId SK, on-demand billing, no GSIs needed Phase 1
  - Shared table uses PK/SK entity prefixes (CHAT#, USER#, EVENT#, etc.) + one GSI (GSI1PK/GSI1SK)
  - Cost at household scale: ~$0/month (well within free tier)
  - See: `/docs/features/homeops-p1-infra/research/dynamodb-design.md`
- CDK monorepo patterns: single package.json, NodejsFunction+esbuild (ESM, bundled SDK), single stack, Node.js 22 ARM64
  - 3 logical constructs: IngestionApi, MessageProcessing, MessageStore
  - Runtime secrets fetch with module-scope caching (not Lambda extension)
  - Base tsconfig.json + tsconfig.cdk.json extension pattern
  - See: `/docs/features/homeops-p1-infra/research/cdk-patterns.md`
- Telegram webhook integration: HTTP API (not REST API), secret_token validation, custom minimal TS types
  - allowed_updates: ["message"] to reduce Lambda invocations
  - Always return 200 except on SQS failure (500) or invalid secret (401)
  - Payload format 2.0: headers lowercased, body is string to JSON.parse
  - Secret token stored in Secrets Manager, cached at cold start
  - See: `/docs/features/homeops-p1-infra/research/telegram-webhook.md`

## Research Approaches
- WebSearch is effective for AWS pricing, CDK patterns, and best practices
- WebFetch is denied in this environment; rely on WebSearch summaries
- Always read the PRD first to anchor research in specific requirements
- Cross-reference PRD line numbers when justifying decisions

## Phase 2 Decisions
- OpenAI integration: Structured Outputs with `response_format: { type: "json_schema" }` + `zodResponseFormat()` helper
  - `openai` npm package + `zod` dependency; `client.beta.chat.completions.parse()` for typed parsing
  - gpt-4o-mini model (~$0.00015/classification, ~$0.90/month at 200 msgs/day)
  - temperature: 0.2, max_completion_tokens: 200, timeout: 10s, maxRetries: 1
  - Graceful failure: classification errors logged but do not block SQS pipeline
  - Prompt-based confidence calibration with explicit bands and diverse few-shot examples
  - Consider increasing Worker Lambda timeout from 30s to 60s for OpenAI latency
  - See: `/docs/features/homeops-p2-classification/research/openai-structured-output.md`
- DynamoDB patterns for Phase 2:
  - ULID via `ulidx` for activityId sort key (time-ordered, 26 chars, seed with message timestamp)
  - Atomic counter with `ADD` UpdateExpression for response rate limiting (natural upsert, concurrent-safe)
  - Stockholm timezone via `Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Stockholm" })` -- zero deps, DST-safe
  - TTL on response_counters: `ttl` attribute in Unix epoch seconds, 7-day expiry from date string
  - Activities GSI: `userId-timestamp-index` with ALL projection (items ~0.5KB, cost negligible)
  - Fast conversation detection: Query last 10 messages, filter in app code (no timestamp GSI needed)
  - Worker uses low-level `@aws-sdk/client-dynamodb` -- stay consistent, defer `lib-dynamodb` introduction
  - New CDK construct: `ActivityStore` (activities + response_counters tables)
  - See: `/docs/features/homeops-p2-classification/research/dynamodb-patterns.md`
- Telegram Bot API responses: sendMessage with reply_parameters, privacy mode, rate limits, error handling
  - Use `reply_parameters` (not deprecated `reply_to_message_id`) with `allow_sending_without_reply: true`
  - Plain text (no parse_mode) for short Swedish responses -- avoids MarkdownV2 escaping issues
  - Privacy mode must be DISABLED (or bot made admin) to receive all messages for classification
  - Rate limits irrelevant at 3 msgs/day (Telegram allows 20/min per group)
  - Never retry failed sends; classification is critical path, response is optional
  - Detect "directly addressed" via `entities[].type === "mention"` and `reply_to_message.from.id === botId`
  - Cache bot identity (getMe) at module scope; extend TelegramMessage type with `reply_to_message` field
  - Use native `fetch` with 5s timeout, not an SDK
  - See: `/docs/features/homeops-p2-classification/research/telegram-responses.md`
- Phase 2 PRD: `/docs/features/homeops-p2-classification/prd.md`

## Phase 3 Decisions
- DynamoDB patterns for Phase 3 memory system:
  - Alias lookup: Query on PK=`ALIAS#<chatId>`, cache in Lambda module scope (5-min TTL)
  - Reverse alias GSI: Use existing GSI1 on `homeops` table (no CDK changes needed)
  - Pattern habit maps: Read-modify-write (GetItem + PutItem) simpler than nested UpdateExpression
  - DynamoDB nested map increment: Cannot use `ADD` on nested paths; use `if_not_exists` with `SET`
  - Memory queries need new GSI: `chatId-activity-index` on activities table (composite SK: `activity#timestamp`)
  - One GSI on `homeops` table sufficient for all Phase 3 (and likely all 6 phases)
  - All Phase 3 records in existing `homeops` single table -- no new tables needed
  - Per-message cost: ~5 RCU + ~8 WCU for classified msgs; well within free tier
  - CDK changes: new GSI on activities, grant homeops table to worker, pass HOMEOPS_TABLE_NAME env var
  - See: `/docs/features/homeops-p3-learning/research/dynamodb-patterns.md`
- Clarification response detection (alias learning):
  - Hybrid approach: rule-based for affirmatives/negations, existing classifier for corrections
  - Swedish affirmatives are a closed set (~30 words) -- regex matching is >98% accurate
  - Corrections: strip negation prefix, run through classifyMessage for canonical activity extraction
  - Extend ingest handler: pass `replyToText` in SQS body for worker to check if reply targets clarification
  - Extract suggested activity from bot text via regex `/^Menade du (.+)\?$/` -- no DynamoDB lookup needed
  - Alias key: classifier's activity field (e.g., "pant"); maps to canonical form (e.g., "pantning")
  - 1 confirmation creates alias; 3+ marks "reliable"; explicit corrections always override
  - "nähä" and "nämen" are NOT negations in Swedish -- only nä/nää/nej/nix/nope
  - Swedish `jo` is used interchangeably with `ja` in informal messaging (treat both as affirmative)
  - See: `/docs/features/homeops-p3-learning/research/clarification-detection.md`
- Telegram DM lifecycle: /start detection, channel routing, DM opt-in
  - Bots cannot initiate private chats; user must /start first (Telegram anti-spam)
  - In private chats, chat.id === from.id (user ID); store privateChatId = userId
  - Current `allowed_updates: ["message"]` already delivers /start from private chats
  - Detect private chat via `chat.type === "private"` -- add chatType to SQS MessageBody
  - Make `replyToMessageId` optional in telegram-sender for proactive DM sends
  - Blocked user: 403 error; reactively mark optedIn=false (no need for my_chat_member webhook)
  - Unblocking alone is NOT sufficient -- user must send /start again
  - DM daily cap naturally isolated from group cap by chatId key
  - Deep link `t.me/botusername?start=onboard` for clickable onboarding prompt
  - Worker needs homeops table access for DM status records (DM#<userId>/STATUS)
  - See: `/docs/features/homeops-p3-learning/research/telegram-dm-lifecycle.md`
- EMA implementation patterns for effort and engagement tracking:
  - DynamoDB UpdateExpression does NOT support multiplication -- cannot do atomic EMA update
  - Must use read-then-conditional-write with optimistic locking (sampleCount as version)
  - Swallow ConditionalCheckFailedException -- EMA self-corrects on next observation
  - Round EMA to 4 decimal places before storage (prevents JS float noise)
  - DynamoDB Number type: up to 38 digits precision, stored as decimal strings (not IEEE 754)
  - Alpha=0.3 half-life: ~2 observations; 95% decay: ~9 observations
  - Alpha=0.2 half-life: ~3 observations; 95% decay: ~13 observations
  - Half-life formula: log(0.5) / log(1 - alpha)
  - EMA on binary 0/1 values = exponentially weighted proportion, bounded [0,1]
  - 10-data-point threshold belongs in response policy, not EMA service
  - Active hours: derive from PATTERN records' hourOfDayCounts (avoid separate metric)
  - Interaction frequency: EMA on daily message counts, triggered on date change
  - See: `/docs/features/homeops-p3-learning/research/ema-implementation.md`
- Phase 3 PRD: `/docs/features/homeops-p3-learning/prd.md`

## Codebase Structure
- Phase 1+2 deployed: `/infra` (CDK), `/src` (Lambda handlers), `/test`
- Handlers: ingest, worker, health in `/src/handlers/`
- Shared: types/telegram.ts, classification.ts, utils/secrets.ts, utils/stockholm-time.ts in `/src/shared/`
- Services: classifier, activity-store, response-counter, response-policy, fast-conversation, telegram-sender in `/src/shared/services/`
- CDK: MessageStore (all 4 tables + GSIs), MessageProcessing (SQS + worker Lambda), IngestionApi
- Tables: homeops-messages, homeops (single table + GSI1), homeops-activities (+ userId-timestamp-index GSI), homeops-response-counters
- Research outputs: `/docs/features/homeops-p{1,2,3}-*/research/`

## DynamoDB Technical Notes
- `ADD` action only works on top-level Number/Set attributes, not nested map paths
- For nested map counters: use `SET parent = if_not_exists(parent, :emptyMap)` then `SET parent.key = if_not_exists(parent.key, :zero) + :one`
- Caveat: path resolution for nested SET happens BEFORE the update, so initializing parent + setting child in same expression may fail on brand-new items
- Safe pattern: conditional update (ConditionExpression attribute_exists) with PutItem fallback for first write
- Simpler at low scale: read-modify-write (GetItem + PutItem) avoids all nested expression complexity
