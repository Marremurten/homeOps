# SQS Queue Configuration Research

**Feature:** homeops-p1-infra
**Research Area:** SQS queue configuration for Telegram message ingestion pipeline
**Architecture:** Ingest Lambda -> SQS Queue -> Worker Lambda -> DynamoDB
**Throughput profile:** Low (~50-200 messages/day, household use case)

## Summary

A Standard SQS queue is the correct choice for this use case. The combination of low throughput (well under 1 message/second), an already-idempotent worker (checks `messageId` before writing to DynamoDB), and no ordering requirement makes FIFO overhead unjustified. The entire SQS cost will be zero under the AWS Free Tier (1 million requests/month vs ~600 requests/month actual usage). Configuration should prioritize simplicity and debuggability over optimization.

---

## 1. Standard vs FIFO Queue

### Standard Queue

| Property | Value |
|---|---|
| Delivery guarantee | At-least-once |
| Ordering | Best-effort (not guaranteed) |
| Throughput | Nearly unlimited |
| Deduplication | None (application must handle) |
| Cost | $0.40 per million requests (after free tier) |
| Queue name | Any valid name |

### FIFO Queue

| Property | Value |
|---|---|
| Delivery guarantee | Exactly-once (within 5-minute dedup window) |
| Ordering | Strict FIFO per message group |
| Throughput | 300 msg/sec without batching, 3,000 with batching |
| Deduplication | Content-based or explicit `MessageDeduplicationId` |
| Cost | $0.50 per million requests (after free tier, 25% more) |
| Queue name | Must end with `.fifo` suffix |

### Analysis for HomeOps

**Ordering is irrelevant.** Telegram messages arrive via webhook sequentially, but even if two messages arrived out of order in DynamoDB, each record has a `timestamp` and `messageId` (sort key). The data model supports reconstruction of order regardless of write order. Phase 1 only stores raw messages; no downstream processing depends on write order.

**Exactly-once delivery is redundant.** The PRD already requires the Worker Lambda to be idempotent: "Idempotent: check if messageId already exists before writing" (PRD line 70). The DynamoDB write uses a conditional expression on `chatId` (PK) + `messageId` (SK), which is a natural idempotency key. A duplicate SQS delivery simply results in a no-op conditional write.

**FIFO adds complexity for no benefit:**
- Queue name must end in `.fifo`
- Every `sendMessage` call must include a `MessageGroupId`
- Every `sendMessage` call must include a `MessageDeduplicationId` (or enable content-based dedup)
- Harder to test locally
- More configuration surface area

**Throughput:** At 200 messages/day, we are at ~0.002 messages/second. Both queue types are wildly overprovisioned, so throughput limits are irrelevant.

### Verdict: Standard Queue

FIFO provides zero functional benefit given the existing application-level idempotency and the absence of an ordering requirement. Standard is simpler to configure and reason about.

---

## 2. Deduplication Strategies

### Why Deduplication Matters

Telegram retries webhook delivery if it does not receive a 2xx response within a reasonable time. The Ingest Lambda returns 200 immediately, but network issues or Lambda cold starts could cause Telegram to retry, potentially enqueuing the same message twice.

### Option A: FIFO Queue with MessageDeduplicationId (Rejected)

If using a FIFO queue, you could set `MessageDeduplicationId` to Telegram's `message_id` (scoped per chat):

```typescript
// Hypothetical FIFO approach (NOT recommended)
await sqs.sendMessage({
  QueueUrl: queueUrl,
  MessageBody: JSON.stringify(telegramUpdate),
  MessageGroupId: String(chatId),
  MessageDeduplicationId: `${chatId}-${messageId}`,
}).promise();
```

**Limitation:** The deduplication window is only 5 minutes. If the same message is re-sent after 5 minutes (unlikely but possible with Telegram retries during outages), FIFO dedup will not catch it.

### Option B: FIFO Queue with Content-Based Deduplication (Rejected)

FIFO queues can auto-generate a dedup ID from a SHA-256 hash of the message body. However, if the Ingest Lambda adds any dynamic field (timestamp, request ID) to the message body, content-based dedup breaks silently. This is fragile.

### Option C: Application-Level Deduplication in Worker (Recommended)

The worker Lambda uses DynamoDB conditional writes to achieve deduplication:

```typescript
// Worker Lambda idempotent write
await dynamodb.put({
  TableName: 'messages',
  Item: {
    chatId: String(chatId),
    messageId: messageId,
    userId: userId,
    userName: userName,
    text: text,
    timestamp: timestamp,
    raw: JSON.stringify(update),
    createdAt: new Date().toISOString(),
  },
  ConditionExpression: 'attribute_not_exists(chatId) AND attribute_not_exists(messageId)',
}).promise();
```

If the item already exists, DynamoDB throws `ConditionalCheckFailedException`, which the worker catches and treats as a successful (no-op) processing. This approach:

- Works regardless of queue type
- Has no time window limitation (dedup is permanent, stored in DynamoDB)
- Uses the natural primary key (`chatId` + `messageId`) as the dedup key
- Costs nothing extra (the conditional check is part of the write operation)

### Additional Safeguard: SQS Message Attributes

Even with a Standard queue, set `messageId` as an SQS message attribute for observability:

```typescript
await sqs.sendMessage({
  QueueUrl: queueUrl,
  MessageBody: JSON.stringify(telegramUpdate),
  MessageAttributes: {
    'telegramMessageId': {
      DataType: 'Number',
      StringValue: String(messageId),
    },
    'chatId': {
      DataType: 'String',
      StringValue: String(chatId),
    },
  },
}).promise();
```

This makes messages searchable/filterable in the AWS Console without parsing the body.

### Verdict: Application-Level Deduplication

Use Standard queue + DynamoDB conditional writes. This is simpler, more reliable (no 5-minute window), and already required by the PRD's idempotency requirement.

---

## 3. Visibility Timeout

### What It Does

When a consumer (Worker Lambda) receives a message from SQS, the message becomes "invisible" to other consumers for the duration of the visibility timeout. If the consumer does not delete the message before the timeout expires, the message becomes visible again and can be received by another consumer (or the same one).

### AWS Recommendation

> Set your queue's visibility timeout to **6 times your Lambda function timeout**, plus the value of `MaximumBatchingWindowInSeconds`.

Source: [AWS Lambda SQS documentation](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)

### Calculation for HomeOps

The Worker Lambda's job is simple: parse message, conditional DynamoDB write. Expected execution time: 100-500ms.

| Parameter | Value | Rationale |
|---|---|---|
| Lambda timeout | 30 seconds | Conservative for cold starts + DynamoDB write |
| Batch window | 0 seconds | Batch size 1, no batching window |
| **Visibility timeout** | **180 seconds (3 minutes)** | 30s x 6 = 180s |

**Why 30 seconds for the Lambda timeout?** The actual processing is fast (~500ms), but we need headroom for:
- Cold starts (can be 1-3 seconds for Node.js)
- DynamoDB throttling retries (unlikely at this throughput, but defensive)
- Network latency

**Why 6x?** The 6x multiplier accounts for:
- Lambda execution time (1x)
- Lambda retry on throttle (up to 2 more attempts = 3x)
- Buffer for SQS internal processing (remaining 3x)

### Important Constraint

Lambda validates that the function timeout does not exceed the queue's visibility timeout when creating or updating the event source mapping. If `Lambda timeout > visibility timeout`, the deployment will fail.

### Verdict: 180 seconds visibility timeout

With a 30-second Lambda timeout and batch size 1, set visibility timeout to 180 seconds (3 minutes).

---

## 4. Dead Letter Queue (DLQ) Configuration

### Purpose

Messages that fail processing after multiple attempts are moved to a separate DLQ rather than being retried indefinitely. This prevents poison messages from blocking the queue and provides a debugging mechanism.

### maxReceiveCount

The `maxReceiveCount` determines how many times a message can be received (and fail) before being moved to the DLQ.

| Value | Behavior |
|---|---|
| 1 | DLQ after first failure (too aggressive) |
| 3 | DLQ after 3 failures (PRD specifies this) |
| 5 | AWS recommendation for Lambda integrations |

The PRD states: "Failed messages go to DLQ after 3 retries" (line 73). However, AWS recommends `maxReceiveCount >= 5` for Lambda event source mappings because Lambda may internally retry on throttling, which counts against the receive count.

**Recommendation: `maxReceiveCount: 3`** as specified in the PRD. At this throughput, Lambda throttling is essentially impossible. If we see false-positive DLQ messages in practice, we can increase to 5.

### DLQ Retention Period

| Scenario | Retention | Rationale |
|---|---|---|
| Standard | 4 days (default) | Too short for a household project |
| **Recommended** | **14 days** | Enough time to notice and debug, not so long that stale messages accumulate |
| Maximum | 14 days (SQS max) | The maximum allowed by SQS |

Note: SQS maximum retention period is 14 days. Set the DLQ to the maximum since storage costs are negligible at this volume.

### CloudWatch Alarm on DLQ

The PRD requires: "DLQ depth > 0" alarm (line 88). Configuration:

```typescript
// CDK alarm configuration
const dlqAlarm = new cloudwatch.Alarm(this, 'DlqAlarm', {
  alarmDescription: 'Messages in the dead letter queue',
  metric: dlq.metricApproximateNumberOfMessagesVisible(),
  threshold: 0,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  evaluationPeriods: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
```

**Monitoring and Replay:**

For DLQ replay, AWS provides built-in DLQ redrive functionality. You can configure the DLQ to allow redrive to the source queue. This can be done via the AWS Console or CLI:

```bash
# Replay DLQ messages back to source queue (CLI)
aws sqs start-message-move-task \
  --source-arn arn:aws:sqs:eu-north-1:ACCOUNT:homeops-dlq \
  --destination-arn arn:aws:sqs:eu-north-1:ACCOUNT:homeops-queue
```

In CDK, ensure the DLQ has the `redriveAllowPolicy` set to allow redrive from the source queue (this is the default behavior when using CDK's `DeadLetterQueue` construct).

### DLQ Configuration Summary

| Parameter | Value |
|---|---|
| maxReceiveCount | 3 |
| DLQ retention period | 14 days |
| CloudWatch alarm threshold | > 0 messages visible |
| Alarm evaluation periods | 1 |
| Redrive | Enabled (back to source queue) |

---

## 5. Batch Processing

### Current Configuration (PRD)

The PRD specifies: "batch size 1 initially" (line 69).

### Lambda SQS Event Source Mapping Parameters

| Parameter | Value | Rationale |
|---|---|---|
| `batchSize` | 1 | Process one message at a time; simplest to implement and debug |
| `maxBatchingWindow` | 0 (default) | No delay; process immediately when message arrives |
| `reportBatchItemFailures` | true | Enable even with batch size 1 for future-proofing |
| `enabled` | true | Active from deployment |

### When to Increase Batch Size

Increase from 1 to a larger batch size when:

1. **Throughput increases significantly** (e.g., multiple Telegram groups, >1000 messages/day) and you want to reduce Lambda invocation costs
2. **Processing becomes compute-heavy** (e.g., Phase 2 adds OpenAI classification) and you want to amortize cold start overhead across multiple messages
3. **DynamoDB batch writes** become beneficial (batch write can handle up to 25 items)

At 200 messages/day, batch size 1 means ~200 Lambda invocations/day. This is well within free tier (400,000 GB-seconds/month). There is no economic or performance reason to batch.

### Partial Batch Failure Reporting

Even with batch size 1, enable `reportBatchItemFailures` in the event source mapping. This is a no-op for single messages but means you do not need to change the event source mapping configuration if you increase batch size later.

Worker Lambda response format for partial batch failures:

```typescript
import { SQSHandler, SQSBatchResponse } from 'aws-lambda';

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      // Process message
      await processMessage(record);
    } catch (error) {
      // Report this specific message as failed
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
```

### Verdict: Batch Size 1 with ReportBatchItemFailures

Start with batch size 1. Enable partial batch failure reporting from day one for zero-cost future-proofing.

---

## 6. Cost Analysis

### SQS Requests per Month

For each message flowing through the pipeline:

| Operation | Requests | Notes |
|---|---|---|
| SendMessage (Ingest Lambda) | 1 | Enqueue message |
| ReceiveMessage (Lambda polling) | Variable | Lambda polls even when queue is empty |
| DeleteMessage (Worker Lambda) | 1 | After successful processing |

Lambda's SQS event source mapping continuously polls the queue using long polling. When the queue is empty, it performs approximately 1 empty receive per 20 seconds, which is ~130,000 empty receives/month. Each receive is one SQS API call.

**Estimated monthly SQS requests:**

| Component | Requests/Month |
|---|---|
| SendMessage | ~6,000 (200/day x 30) |
| ReceiveMessage (with messages) | ~6,000 |
| ReceiveMessage (empty polls) | ~130,000 |
| DeleteMessage | ~6,000 |
| **Total** | **~148,000** |

### Cost Comparison

| Queue Type | Requests/Month | Free Tier | Billable | Monthly Cost |
|---|---|---|---|---|
| Standard | ~148,000 | 1,000,000 | 0 | **$0.00** |
| FIFO | ~148,000 | 1,000,000 | 0 | **$0.00** |

**Both queue types are effectively free.** The free tier of 1 million requests/month is ~6.7x the actual usage. Even if you had 10 Telegram groups doing 1,000 messages/day each, you would still be within the free tier.

### If Free Tier Were Exhausted

| Queue Type | Rate | 148K requests cost |
|---|---|---|
| Standard | $0.40/million | $0.06/month |
| FIFO | $0.50/million | $0.07/month |

The cost difference between Standard and FIFO is approximately $0.01/month at this volume. Cost is not a differentiator; simplicity is.

### Other Cost Factors

| Service | Monthly Cost |
|---|---|
| Lambda (Ingest + Worker) | $0.00 (free tier: 1M requests + 400K GB-sec) |
| DynamoDB (on-demand) | $0.00 (free tier: 25 GB storage, 25 WCU/RCU) |
| API Gateway (HTTP API) | $0.00 (free tier: 1M requests for 12 months) |
| CloudWatch Logs | ~$0.01 (minimal log volume) |
| **Total stack** | **~$0.01/month** |

---

## 7. CDK Configuration

### Complete SQS + DLQ + Event Source Mapping

```typescript
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

// ---- Dead Letter Queue ----
const dlq = new sqs.Queue(this, 'MessagesDlq', {
  queueName: 'homeops-messages-dlq',
  retentionPeriod: cdk.Duration.days(14),
  // No visibility timeout needed for DLQ (manual inspection/replay)
});

// ---- Main Queue ----
const queue = new sqs.Queue(this, 'MessagesQueue', {
  queueName: 'homeops-messages',
  visibilityTimeout: cdk.Duration.seconds(180), // 6x Lambda timeout (30s)
  retentionPeriod: cdk.Duration.days(4),         // Default; messages should process quickly
  deadLetterQueue: {
    queue: dlq,
    maxReceiveCount: 3, // Move to DLQ after 3 failed processing attempts
  },
});

// ---- Worker Lambda ----
const workerLambda = new lambda.Function(this, 'WorkerLambda', {
  functionName: 'homeops-worker',
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'worker.handler',
  code: lambda.Code.fromAsset('src/handlers'),
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
  environment: {
    TABLE_NAME: messagesTable.tableName,
  },
});

// ---- Event Source Mapping ----
workerLambda.addEventSource(
  new lambdaEventSources.SqsEventSource(queue, {
    batchSize: 1,
    maxBatchingWindow: cdk.Duration.seconds(0),
    reportBatchItemFailures: true,
  })
);

// ---- DLQ CloudWatch Alarm ----
const dlqAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
  alarmName: 'homeops-dlq-depth',
  alarmDescription: 'One or more messages in the HomeOps dead letter queue',
  metric: dlq.metricApproximateNumberOfMessagesVisible({
    period: cdk.Duration.minutes(1),
    statistic: 'Maximum',
  }),
  threshold: 0,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  evaluationPeriods: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});

// ---- Grant Permissions ----
queue.grantSendMessages(ingestLambda);    // Ingest Lambda can enqueue
queue.grantConsumeMessages(workerLambda); // Worker Lambda can dequeue + delete
```

### Key CDK Notes

1. **`grantConsumeMessages`** grants `sqs:ReceiveMessage`, `sqs:ChangeMessageVisibility`, `sqs:DeleteMessage`, and `sqs:GetQueueAttributes`. This is the least-privilege grant for a consumer.

2. **`grantSendMessages`** grants `sqs:SendMessage` and `sqs:GetQueueUrl`. This is the least-privilege grant for a producer.

3. **Event source mapping** is automatically created by `addEventSource`. CDK handles the IAM role attachment.

4. **`reportBatchItemFailures: true`** requires the Lambda function to return an `SQSBatchResponse` object. If the function returns void or throws, all messages in the batch are retried.

5. **The DLQ alarm** uses `GREATER_THAN_THRESHOLD` with threshold 0, which fires when there is 1 or more message. `treatMissingData: NOT_BREACHING` prevents false alarms when CloudWatch has no data points.

---

## Recommendations

### Recommended Configuration Values

| Parameter | Value | Notes |
|---|---|---|
| Queue type | **Standard** | No ordering or exactly-once requirement |
| Visibility timeout | **180 seconds** | 6x Lambda timeout (30s) |
| Message retention | **4 days** | Default; messages process within seconds |
| DLQ max receive count | **3** | Per PRD; increase to 5 if false positives occur |
| DLQ retention | **14 days** | Maximum allowed; gives ample debug time |
| Batch size | **1** | Per PRD; simplest for Phase 1 |
| Batch window | **0 seconds** | No batching delay |
| Report batch item failures | **true** | Future-proofing; no cost |
| Lambda timeout | **30 seconds** | Conservative for cold starts |
| Lambda memory | **256 MB** | Sufficient for parse + DynamoDB write |
| Deduplication | **Application-level** | DynamoDB conditional write on `chatId` + `messageId` |
| DLQ alarm | **> 0 messages** | Alert on any DLQ message |

### Implementation Checklist

1. Create DLQ with 14-day retention
2. Create Standard queue with DLQ redrive policy (maxReceiveCount: 3)
3. Set visibility timeout to 180 seconds
4. Create Worker Lambda with 30s timeout
5. Add SQS event source mapping with batchSize 1 and reportBatchItemFailures
6. Create CloudWatch alarm on DLQ `ApproximateNumberOfMessagesVisible > 0`
7. Grant `sendMessages` to Ingest Lambda, `consumeMessages` to Worker Lambda
8. Implement conditional DynamoDB write in Worker Lambda for idempotency

---

## Trade-offs

### Choosing Standard over FIFO

| You gain | You give up |
|---|---|
| Simpler configuration (no MessageGroupId, no DeduplicationId) | SQS-level exactly-once delivery (mitigated by app-level dedup) |
| Simpler testing and debugging | Strict message ordering (not needed) |
| No `.fifo` suffix requirement | 5-minute dedup window at queue level (app-level is permanent) |
| Fewer moving parts | Content-based dedup option (not needed) |

### Choosing maxReceiveCount 3 over 5

| You gain | You give up |
|---|---|
| Faster DLQ routing for genuine poison messages | Tolerance for transient Lambda throttling (negligible at this volume) |
| PRD compliance | AWS's general recommendation of >= 5 |
| Quicker visibility into issues | Extra retry opportunities for intermittent failures |

### Choosing batch size 1

| You gain | You give up |
|---|---|
| Simplest error handling (one message = one invocation) | Lambda invocation cost efficiency (irrelevant at free tier) |
| Easiest debugging and observability | Amortized cold start costs (irrelevant with 200 msg/day) |
| No partial batch failure complexity | DynamoDB batch write optimization (not needed) |

---

## Open Questions

1. **DLQ alarm notification target.** The PRD specifies a CloudWatch alarm on DLQ depth, but does not specify where notifications should be sent (email via SNS, Slack, etc.). For Phase 1, the alarm existing in CloudWatch may be sufficient, with SNS email notifications added if desired.

2. **Queue encryption.** Should the SQS queue use SSE-SQS (free, default since 2023) or SSE-KMS (additional cost for CMK)? Recommendation: Use SSE-SQS (server-side encryption with SQS-managed keys), which is the default and free. The messages contain Telegram chat text, not financial or health data, so SQS-managed encryption is sufficient.

3. **Message size limit.** SQS messages have a 256 KB limit. A Telegram update JSON is typically 1-5 KB, so this is not a concern. However, if the raw Telegram update includes large photo/document metadata, it could approach this limit in edge cases. The Ingest Lambda should validate message size before enqueuing.

4. **DLQ consumer.** Who or what processes DLQ messages? For Phase 1, manual inspection via AWS Console or CLI is likely sufficient. A dedicated DLQ consumer Lambda could be added later if DLQ messages need automated reprocessing.

5. **Lambda reserved concurrency.** Should the Worker Lambda have reserved concurrency set to 1 to prevent parallel processing? At 200 messages/day this is unnecessary, and setting reserved concurrency to 1 could cause throttling during burst scenarios (e.g., when first connecting the webhook and receiving historical messages). Leave unrestricted for Phase 1.
