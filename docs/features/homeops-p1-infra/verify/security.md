# Security Review: homeops-p1-infra

**Reviewer:** security-reviewer
**Date:** 2026-02-17
**Status:** PASS with findings (no blocking issues)

---

## Overall Assessment

The implementation follows security best practices for a serverless Telegram ingestion pipeline. Secrets are stored in AWS Secrets Manager with no hardcoded values, IAM permissions are scoped using CDK grants, and the webhook endpoint validates a secret token before processing. DynamoDB tables use AWS-managed encryption at rest (default). No known CVEs in dependencies (`pnpm audit` clean, 275 deps, 0 vulnerabilities).

There are no **Critical** or **High** severity findings. Several **Medium** and **Low** findings warrant attention, mostly around input validation robustness, missing structured logging, and hardening opportunities.

---

## Threat Model

| Threat Actor | Motivation | Attack Surface |
|---|---|---|
| External attacker | Abuse public webhook endpoint | API Gateway POST /webhook |
| Telegram impersonator | Inject malicious payloads | Forged webhook requests with valid-looking structure |
| Compromised dependency | Supply chain attack | npm packages bundled into Lambda |
| Insider / misconfiguration | Accidental data leak | CloudWatch logs, DLQ messages |

---

## Findings

### F1. JSON.parse on untrusted input without try/catch in ingest handler

- **Severity:** Medium
- **File:** `/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts:27`
- **Description:** `JSON.parse(event.body)` is called on the raw request body after token validation but without its own guard. If `event.body` is not valid JSON, this throws and falls through to the outer catch block, returning a 500 error. A 500 response causes Telegram to retry the malformed payload repeatedly (Telegram retries on non-2xx), creating unnecessary Lambda invocations and log noise.
- **Recommendation:** Wrap `JSON.parse` in a try/catch and return 200 for parse failures (malformed body is not retryable). Alternatively, add a specific check before parsing. This prevents Telegram retry storms from malformed payloads.
- **Blocking:** No

### F2. Non-null assertion on `response.SecretString` in secrets utility

- **Severity:** Low
- **File:** `/Users/martinnordlund/homeOps/src/shared/utils/secrets.ts:27`
- **Description:** `response.SecretString!` uses a non-null assertion. If the secret is stored as binary (`SecretBinary`) rather than string, or if the ARN is wrong, this would produce `undefined` cached as a valid value, leading to the ingest handler comparing the webhook token against `undefined` (always failing, returning 401 for all requests).
- **Recommendation:** Add a guard: `if (!response.SecretString) throw new Error('Secret not found or not a string secret')`. This makes failure explicit rather than silently breaking authentication.
- **Blocking:** No

### F3. Missing structured logging in all Lambda handlers

- **Severity:** Medium
- **File:** `/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts` (all handlers)
- **Description:** The PRD specifies "Structured logging (JSON) for all operations" and the plan confirms this requirement. However, none of the three handlers (`ingest`, `worker`, `health`) contain any `console.log`, `console.error`, or structured logging calls. This means:
  - No audit trail of authentication failures (401s)
  - No visibility into which messages were processed or skipped
  - No logging of SQS enqueue or DynamoDB write operations
  - Errors in the catch block of ingest are silently swallowed (500 returned but no log)
- **Recommendation:** Add structured JSON logging (`console.log(JSON.stringify({...}))`) for: auth failures (without leaking token values), message processing decisions, SQS/DynamoDB operations, and errors. Do not log the raw secret token, bot token, or full message text (PII consideration).
- **Blocking:** No (functionality works, but operational/audit visibility is zero)

### F4. Ingest Lambda missing ESM bundling configuration

- **Severity:** Low
- **File:** `/Users/martinnordlund/homeOps/infra/constructs/ingestion-api.ts:27-38`
- **Description:** The Worker Lambda at `/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts:43-47` has explicit `bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true }` configuration, but the Ingest Lambda and Health Lambda in `ingestion-api.ts` do not specify bundling options. The plan states "ESM Lambda bundles (minified, source maps)" as a decision. While NodejsFunction uses esbuild by default, the absence of explicit ESM format means these Lambdas may be bundled as CJS, which is inconsistent and means no tree-shaking benefits.
- **Recommendation:** Add the same `bundling` configuration to both `IngestFn` and `HealthFn` for consistency.
- **Blocking:** No

### F5. No rate limiting or throttling on API Gateway

- **Severity:** Low
- **File:** `/Users/martinnordlund/homeOps/infra/constructs/ingestion-api.ts:25`
- **Description:** The HTTP API is created with default settings (`new HttpApi(this, "HttpApi")`) and no throttling configuration. HTTP API has default AWS throttling (10,000 requests/second burst, 5,000 sustained), which is generous. An attacker who discovers the endpoint URL (even without the secret token) could send high volumes of requests. Each request would invoke the Lambda (incurring cost), fetch the secret, and return 401.
- **Recommendation:** Configure stage-level throttling on the HTTP API to a reasonable limit (e.g., 100 req/s burst, 50 sustained) appropriate for a single Telegram bot. This limits cost exposure from abuse. Example: `defaultStage: { throttle: { burstLimit: 100, rateLimit: 50 } }`.
- **Blocking:** No

### F6. Shell script vulnerable to injection via URL argument

- **Severity:** Medium
- **File:** `/Users/martinnordlund/homeOps/scripts/register-webhook.sh:111`
- **Description:** The `WEBHOOK_URL` variable is interpolated directly into a JSON string passed to `curl -d`. If the API Gateway URL argument contains characters like `"` or `\`, they would break the JSON structure. Additionally, the `BOT_TOKEN` and `WEBHOOK_SECRET` values from Secrets Manager are interpolated into the JSON body and URL without escaping.
  ```bash
  -d "{
      \"url\": \"${WEBHOOK_URL}\",
      \"secret_token\": \"${WEBHOOK_SECRET}\",
      ...
  }"
  ```
  A secret value containing a double quote would break the JSON and potentially cause unexpected behavior.
- **Recommendation:** Use `jq` (already a dependency) to construct the JSON payload safely:
  ```bash
  PAYLOAD=$(jq -n \
    --arg url "$WEBHOOK_URL" \
    --arg secret "$WEBHOOK_SECRET" \
    '{url: $url, secret_token: $secret, allowed_updates: ["message"], drop_pending_updates: true, max_connections: 10}')
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD"
  ```
- **Blocking:** No

### F7. Secret token comparison is not timing-safe

- **Severity:** Low
- **File:** `/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts:20`
- **Description:** The comparison `token !== secret` uses standard JavaScript string comparison, which is susceptible to timing attacks. An attacker could theoretically measure response times to deduce the secret token character-by-character.
- **Recommendation:** In practice, this is very low risk because: (a) network latency noise far exceeds the timing difference, (b) Telegram secret tokens are 1-256 bytes and the comparison is fast, (c) the attacker would need many thousands of precisely timed requests. For defense-in-depth, Node.js provides `crypto.timingSafeEqual()` for constant-time comparison. This is informational rather than actionable for Phase 1.
- **Blocking:** No

### F8. DynamoDB tables use DESTROY removal policy

- **Severity:** Info
- **File:** `/Users/martinnordlund/homeOps/infra/constructs/message-store.ts:19,28`
- **Description:** Both DynamoDB tables have `removalPolicy: cdk.RemovalPolicy.DESTROY`. This means `cdk destroy` will delete all data. This is intentional per the plan (Phase 1, local deploy, "cdk destroy cleanly removes all resources" is a success criterion), but should be changed to `RETAIN` or `SNAPSHOT` before any production deployment.
- **Recommendation:** Document that removal policy must be changed before production. Consider making it configurable via a `stage` or `environment` parameter.
- **Blocking:** No

### F9. SQS queues lack explicit encryption configuration

- **Severity:** Info
- **File:** `/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts:24-34`
- **Description:** Neither the main SQS queue nor the DLQ specify encryption settings. As of 2023, AWS enables SQS-managed server-side encryption (SSE-SQS) by default for new queues, so messages are encrypted at rest. However, this is implicit rather than explicit in the CDK code.
- **Recommendation:** For clarity and to ensure encryption regardless of any future AWS default changes, consider adding `encryption: sqs.QueueEncryption.SQS_MANAGED` explicitly. This is informational since AWS defaults provide encryption.
- **Blocking:** No

### F10. `from` field accessed with non-null assertion

- **Severity:** Low
- **File:** `/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts:37`
- **Description:** `message.from!` uses a non-null assertion. Per Telegram Bot API docs, the `from` field is optional and may be absent for messages in channels. While `isTextMessage` ensures `message` exists with `text`, it does not guarantee `from` is present. If a channel post has text but no `from`, this would cause `from.id` and `from.username`/`from.first_name` to throw a TypeError, which the outer catch converts to a 500 -- triggering Telegram retries.
- **Recommendation:** Either (a) add a `from` check to `isTextMessage()`: `return update.message !== undefined && typeof update.message.text === "string" && update.message.from !== undefined`, or (b) add a null check before accessing `from` in the handler.
- **Blocking:** No

---

## Verification Checklist

| # | Security Requirement | Status | Notes |
|---|---|---|---|
| 1 | Secrets in Secrets Manager, not hardcoded | PASS | Bot token, webhook secret, OpenAI key all in Secrets Manager (`/Users/martinnordlund/homeOps/infra/stack.ts:16-30`) |
| 2 | IAM least privilege | PASS | Worker gets only `dynamodb:PutItem` on messages table; Ingest gets `sqs:SendMessage` + `secretsmanager:GetSecretValue` scoped to specific resources via CDK grants |
| 3 | DynamoDB encryption at rest | PASS | AWS-managed encryption is default for DynamoDB tables |
| 4 | Webhook secret token validation | PASS | Validated at `/Users/martinnordlund/homeOps/src/handlers/ingest/index.ts:19-25` |
| 5 | No sensitive data in logs | PASS | No logging exists at all (see F3), so no sensitive data can leak. However, the absence of logging is itself a gap. |
| 6 | Input validation on Telegram updates | PARTIAL | `isTextMessage` filters non-text updates, but no schema validation of the full Update structure. `JSON.parse` on untrusted input (F1). Missing `from` guard (F10). |
| 7 | No known CVEs in dependencies | PASS | `pnpm audit` reports 0 vulnerabilities across 275 dependencies |
| 8 | API Gateway public but authenticated | PASS | Public endpoint (required by Telegram) with secret token validation before any processing |
| 9 | DLQ for failed message handling | PASS | DLQ with 14-day retention, maxReceiveCount 3 (`/Users/martinnordlund/homeOps/infra/constructs/message-processing.ts:24-33`) |
| 10 | Idempotent worker (no duplicate writes) | PASS | Conditional PutItem with `attribute_not_exists` (`/Users/martinnordlund/homeOps/src/handlers/worker/index.ts:23-24`) |

---

## Summary

- **Critical findings:** 0
- **High findings:** 0
- **Medium findings:** 3 (F1, F3, F6)
- **Low findings:** 4 (F2, F4, F5, F7, F10)
- **Info findings:** 2 (F8, F9)
- **Blocking issues:** 0

The implementation meets its Phase 1 security requirements. The most impactful improvements would be adding structured logging (F3) for operational visibility, hardening JSON parsing in the ingest handler (F1) to prevent Telegram retry storms, and using `jq` for safe JSON construction in the shell script (F6).
