# Plan Verification: homeops-p2-classification (Phase 2)

## Result: PASS (with warnings)

---

## 1. Coverage Check (PRD Success Criteria -> Plan Tasks)

| # | PRD Success Criterion | Plan Task(s) | Status |
|---|----------------------|--------------|--------|
| SC-1 | Worker Lambda calls OpenAI to classify every incoming Swedish message | Task 2-test/impl (classifier service), Task 11-test/impl (worker pipeline calls `classifyMessage`) | COVERED |
| SC-2 | Messages classified as `chore`, `recovery`, or `none` with confidence score | Task 1-test/impl (Zod schema with type enum + confidence), Task 2-test/impl (returns `ClassificationResult`) | COVERED |
| SC-3 | Classified activities (chore/recovery) stored in DynamoDB `activities` table with full schema | Task 3-test/impl (activity store service), Task 8-test/impl (CDK table + GSI), Task 11-test/impl (worker calls `saveActivity` for chore/recovery, skips for `none`) | COVERED |
| SC-4 | Agent stays silent for messages classified as `none` | Task 7-test case 1 (`respond: false` when type is `none`), Task 11-test case 3 (does not call `evaluateResponsePolicy` for `none`) | COVERED |
| SC-5 | Agent stays silent when confidence < 0.85 (unless clarification range) | Task 7-test case 8 (`respond: false` when confidence < 0.50), Task 7-test case 3 (clarification for 0.50-0.84), Task 7-impl confidence threshold logic | COVERED |
| SC-6 | Agent stays silent outside quiet hours (22:00-07:00 Stockholm) | Task 1-test/impl (`isQuietHours`), Task 7-test case 4 (`respond: false` for quiet hours) | COVERED |
| SC-7 | Agent stays silent when daily response cap (3/chat) reached | Task 4-test/impl (response counter service), Task 7-test case 5 (`respond: false` when count >= 3) | COVERED |
| SC-8 | Agent stays silent during fast-moving conversations (>3 msgs/60s) | Task 5-test/impl (fast conversation detection), Task 7-test case 6 (`respond: false` for fast conversation) | COVERED |
| SC-9 | Clarification questions sent when confidence is 0.50-0.84 (max 5 words) | Task 7-test case 3 (`"Menade du [activity]?"`), Decision 5 (template approach enforces 5-word limit) | COVERED |
| SC-10 | All output respects limits: <= 1 line, neutral tone, <= 1 emoji | Task 1-test/impl (tone validator), Task 7-test case 10 (tone validation before send), Decision 5 (templated output controls length/emoji) | COVERED |
| SC-11 | No responses contain blame, comparison, commands, or judgment | Task 1-test/impl (tone validator blocklist), Task 7-test case 10 (message suppressed on tone failure) | COVERED |
| SC-12 | Telegram Bot API used to send responses back to group chat | Task 6-test/impl (Telegram sender service), Task 11-test case 5 (worker calls `sendMessage`) | COVERED |
| SC-13 | Response counter tracks and enforces daily limit per chat | Task 4-test/impl (counter service), Task 7-test case 5 (policy checks counter), Task 11-test case 7 (increment after successful send) | COVERED |
| SC-14 | OpenAI API errors handled gracefully without blocking the pipeline | Task 2-test cases 4-5 (returns fallback on error), Task 11-test case 8 (processing continues on classification failure) | COVERED |
| SC-15 | Failed Telegram sends logged but do not cause message processing retries | Task 6-test cases 3-4 (returns `ok: false`, no throw), Task 11-test case 9 (processing continues, error logged) | COVERED |

**Coverage Result: 15/15 criteria covered. No gaps.**

---

## 2. Scope Creep Check (Plan Tasks -> PRD Requirements)

| Plan Task | PRD Requirement | Status |
|-----------|----------------|--------|
| Task 1-test/impl: Classification types | PRD 2 (Classification System), PRD 5 (Silence Rules - quiet hours), PRD 7 (Tone Enforcement) | OK |
| Task 2-test/impl: OpenAI classifier service | PRD 1 (OpenAI Integration) | OK |
| Task 3-test/impl: Activity store service | PRD 3 (Activity Event Logging) | OK |
| Task 4-test/impl: Response counter service | PRD 9 (Response Rate Tracking) | OK |
| Task 5-test/impl: Fast conversation detection | PRD 10 (Fast Conversation Detection) | OK |
| Task 6-test/impl: Telegram sender service | PRD 8 (Telegram Response) | OK |
| Task 7-test/impl: Response policy engine | PRD 4 (Group Response Policy), PRD 5 (Silence Rules), PRD 6 (Clarification Policy) | OK |
| Task 8-test/impl: CDK MessageStore extension | PRD 3 (activities table), PRD 9 (response_counters table), PRD DynamoDB Table Design | OK |
| Task 9-test/impl: CDK MessageProcessing + Stack wiring | PRD Constraint (extend Phase 1 CDK stack), supporting infrastructure for all PRD requirements | OK |
| Task 10-test/impl: Ingest Lambda reply metadata | PRD 4 (directly addressed detection - replies to bot) | OK |
| Task 11-test/impl: Worker Lambda pipeline | PRD 1-10 integration, PRD Constraint (classification added to existing worker) | OK |
| Decision 6: `botMessageId` field on activity item | Not in PRD schema | ACKNOWLEDGED |
| Decision 7: Worker timeout 30s->60s, SQS visibility 180s->360s | Not in PRD | ACKNOWLEDGED |
| Decision 14: `lastResponseAt` field on response_counters | Not in PRD schema (PRD has only chatId, date, count, updatedAt) | ACKNOWLEDGED |
| `getMe` endpoint / bot mention detection | PRD 4 "Directly addressed (message mentions bot name or replies to bot)" | OK |

**Acknowledged Items Explanation:**

- **`botMessageId`**: Decision 6 documents the rationale -- ties bot response to triggering activity for traceability. Reasonable implementation detail, does not widen the API surface.
- **Timeout changes**: Decision 7 is based on research -- required to accommodate OpenAI + Telegram latency within the worker processing window. Infrastructure prerequisite.
- **`lastResponseAt`**: Decision 14 documents the rationale -- enables the 15-minute cooldown check from PRD Section 5 ("Agent responded recently within last 15 minutes") without an extra DynamoDB query. Implementation detail supporting a PRD requirement.

**Scope Result: No untraced scope creep. Three acknowledged additions with documented rationale.**

---

## 3. Out-of-Scope Check

| PRD Out-of-Scope Item | Found in Plan? | Status |
|-----------------------|---------------|--------|
| Alias learning / vocabulary mapping (Phase 3) | No | OK |
| Effort learning / EMA refinement (Phase 3) | No | OK |
| Preference learning / ignore rate tracking (Phase 3) | No | OK |
| DM channel routing (Phase 3) | No | OK |
| Balance calculation (Phase 4) | No | OK |
| Fairness engine (Phase 4) | No | OK |
| Dispute detection and intelligence (Phase 4) | No | OK |
| Recovery intelligence / behavior modification (Phase 4) | No | OK |
| Promise detection (Phase 5) | No | OK |
| Planner engine / EventBridge scheduling (Phase 5) | No | OK |
| Proactive behavior (Phase 5) | No | OK |
| DM insights (Phase 6) | No | OK |
| Clarification follow-up tracking (Phase 3) | No -- Decision 13 explicitly opts out of special follow-up logic | OK |
| Multi-language support (Swedish only) | No | OK |

**Out-of-Scope Result: No violations.**

---

## 4. Constraint Check

| PRD Constraint | Respected in Plan? | Status |
|---------------|-------------------|--------|
| OpenAI API (not Anthropic) | Yes -- Task 2 uses `openai` SDK, `gpt-4o-mini` model | OK |
| System prompt in English, user messages in Swedish | Yes -- Task 2-impl specifies English system prompt with Swedish few-shot examples | OK |
| Precision over recall | Yes -- Decision 5 uses templates (predictable), Task 7 defaults to silence, Task 1 tone validator suppresses uncertain output | OK |
| Response frequency hard-capped at <= 3/day per chat | Yes -- Task 4 (counter service), Task 7 checks count >= 3 before responding, constant `DAILY_CAP = 3` | OK |
| Quiet hours: 22:00-07:00 Europe/Stockholm | Yes -- Task 1 `isQuietHours`, Task 7 checks quiet hours in silence chain | OK |
| Counter reset: midnight Europe/Stockholm | Yes -- Task 4 uses date string as SK (YYYY-MM-DD Stockholm), Task 1 `getStockholmDate` provides the date key | OK |
| Existing infrastructure: extend Phase 1 CDK stack, not replace | Yes -- Task 8 modifies existing MessageStore, Task 9 modifies existing MessageProcessing + stack | OK |
| Worker Lambda: classification added to existing worker | Yes -- Task 11 modifies `src/handlers/worker/index.ts`, not a new Lambda | OK |
| Secrets Manager: OpenAI key and Telegram bot token already provisioned | Yes -- Task 9 passes existing secret references, Task 11 fetches via `getSecret` | OK |

**Constraint Result: All 9 constraints respected.**

---

## 5. Context Budget Check

| Task | Files | Count | Status |
|------|-------|-------|--------|
| Task 1-test | `test/shared/classification-schema.test.ts`, `test/shared/stockholm-time.test.ts`, `test/shared/tone-validator.test.ts` | 3 | OK |
| Task 1-impl | `src/shared/types/classification.ts`, `src/shared/utils/stockholm-time.ts`, `src/shared/utils/tone-validator.ts` | 3 (+dependency install) | OK |
| Task 2-test | `test/shared/classifier.test.ts` | 1 | OK |
| Task 2-impl | `src/shared/services/classifier.ts` | 1 | OK |
| Task 3-test | `test/shared/activity-store.test.ts` | 1 | OK |
| Task 3-impl | `src/shared/services/activity-store.ts` | 1 | OK |
| Task 4-test | `test/shared/response-counter.test.ts` | 1 | OK |
| Task 4-impl | `src/shared/services/response-counter.ts` | 1 | OK |
| Task 5-test | `test/shared/fast-conversation.test.ts` | 1 | OK |
| Task 5-impl | `src/shared/services/fast-conversation.ts` | 1 | OK |
| Task 6-test | `test/shared/telegram-sender.test.ts` | 1 | OK |
| Task 6-impl | `src/shared/services/telegram-sender.ts` | 1 | OK |
| Task 7-test | `test/shared/response-policy.test.ts` | 1 | OK |
| Task 7-impl | `src/shared/services/response-policy.ts` | 1 | OK |
| Task 8-test | `test/infra/message-store.test.ts` (modify) | 1 | OK |
| Task 8-impl | `infra/constructs/message-store.ts` (modify) | 1 | OK |
| Task 9-test | `test/infra/message-processing.test.ts` (modify), `test/infra/stack.test.ts` (modify) | 2 | OK |
| Task 9-impl | `infra/constructs/message-processing.ts` (modify), `infra/stack.ts` (modify), `infra/config.ts` (modify) | 3 | OK |
| Task 10-test | `test/handlers/ingest.test.ts` (modify) | 1 | OK |
| Task 10-impl | `src/handlers/ingest/index.ts` (modify), `src/shared/types/telegram.ts` (modify) | 2 | OK |
| Task 11-test | `test/handlers/worker.test.ts` (modify) | 1 | OK |
| Task 11-impl | `src/handlers/worker/index.ts` (modify) | 1 | OK |

**Context Budget Result: All tasks within the 3-5 file limit. Maximum is 3 files (Tasks 1-test, 1-impl, 9-impl).**

---

## 6. TDD Check

| Impl Task | Preceding Test Task | Test Depends on Own Impl? | Status |
|-----------|-------------------|--------------------------|--------|
| Task 1-impl | Task 1-test | No (Task 1-test has no dependencies) | OK |
| Task 2-impl | Task 2-test | No (Task 2-test depends on Task 1-impl, not Task 2-impl) | OK |
| Task 3-impl | Task 3-test | No (Task 3-test depends on Task 1-impl, not Task 3-impl) | OK |
| Task 4-impl | Task 4-test | No (Task 4-test has no dependencies) | OK |
| Task 5-impl | Task 5-test | No (Task 5-test has no dependencies) | OK |
| Task 6-impl | Task 6-test | No (Task 6-test has no dependencies) | OK |
| Task 7-impl | Task 7-test | No (Task 7-test depends on Task 1-impl, not Task 7-impl) | OK |
| Task 8-impl | Task 8-test | No (Task 8-test has no dependencies) | OK |
| Task 9-impl | Task 9-test | No (Task 9-test depends on Task 8-impl, not Task 9-impl) | OK |
| Task 10-impl | Task 10-test | No (Task 10-test has no dependencies) | OK |
| Task 11-impl | Task 11-test | No (Task 11-test depends on Task 1-impl, not Task 11-impl) | OK |

**Wave ordering validates TDD:**
- Wave 1: all test tasks (1, 4, 5, 6, 8, 10)
- Wave 2: their impl tasks (1, 4, 5, 6, 8, 10)
- Wave 3: dependent test tasks (2, 3, 7, 9, 11)
- Wave 4: their impl tasks (2, 3, 7, 9)
- Wave 5: final integration impl (11)

Every impl task is preceded by its test task, and no test task references its own implementation.

**TDD Result: No violations.**

---

## 7. Warnings and Observations

### WARNING: PRD response_counters schema mismatch (minor)

**Severity: WARNING**

The PRD `response_counters` table schema lists 4 attributes: `chatId`, `date`, `count`, `updatedAt`. The plan adds two fields not in the PRD:
- `lastResponseAt` (Decision 14 -- supports the 15-minute cooldown from PRD Section 5)
- `ttl` (PRD mentions "TTL on items older than 7 days" in prose but does not include `ttl` as a table attribute)

Both are justified. The `lastResponseAt` field avoids an extra query to implement a PRD requirement (15-minute cooldown). The `ttl` attribute is the DynamoDB mechanism to implement the PRD's "TTL on items older than 7 days" requirement. Neither is scope creep -- they are implementation details supporting explicit PRD requirements.

### WARNING: Output length enforcement is implicit, not explicit

**Severity: WARNING**

PRD SC-10 requires "All output respects limits: <= 1 line, neutral tone, <= 1 emoji." The plan enforces this via templated responses (Decision 5): `"Noterat ✓"` and `"Menade du [activity]?"`. These templates inherently satisfy the 1-line and 1-emoji constraints. However, there is no explicit runtime validation of output length or emoji count -- it relies on the templates being correct by construction. This is acceptable given the plan's template-only approach, but if response generation ever becomes dynamic, an explicit length/emoji check would be needed.

### INFO: `botMessageId` field on activities table

**Severity: INFO**

The plan adds an optional `botMessageId` field to the activities table that is not in the PRD schema (Decision 6). This is a reasonable implementation detail for correlating bot responses with triggering activities. It does not affect the success criteria or widen the API surface.

### INFO: Ingest Lambda extension (Task 10) for bot-reply detection

**Severity: INFO**

The plan extends the ingest Lambda to pass `replyToMessageId` and `replyToIsBot` through SQS. This is not explicitly in the PRD's Phase 2 scope, but it directly supports PRD Section 4's "Directly addressed (message mentions bot name or replies to bot)" requirement. The `getMe` endpoint (Task 6) handles the mention case; Task 10 handles the reply-to-bot case. Both are necessary to fully implement "directly addressed" detection.

---

## Summary

The plan is well-aligned with the PRD. All 15 success criteria are covered by at least one task pair. All 9 constraints are respected. No out-of-scope items are implemented. TDD ordering is correct across all 11 task pairs and 5 execution waves. Three fields not in the PRD schema (`botMessageId`, `lastResponseAt`, `ttl`) are acknowledged with documented rationale -- all support explicit PRD requirements. Two minor warnings noted: the response_counters schema additions are justified implementation details, and output length/emoji enforcement relies on template correctness rather than runtime validation. No blockers found.
