# Research: CDK TypeScript Monorepo Patterns

**Feature:** homeops-p1-infra
**Question:** Best practices for structuring a CDK TypeScript monorepo with multiple Lambda functions
**Date:** 2026-02-17

## Summary

A CDK TypeScript monorepo for this project size works best with a flat structure (no workspaces), a single `package.json`, and the `NodejsFunction` construct for esbuild bundling. Shared types live alongside Lambda handlers in `/src`, CDK constructs stay in `/infra`, and tests mirror the source structure in `/test`. A single stack is sufficient for this phase, with L2 constructs organized into logical groupings within the stack file.

---

## 1. Monorepo Structure

### Recommended Directory Layout

```
homeops/
  cdk.json                      # CDK app configuration (points to infra/app.ts)
  package.json                  # Single package.json for entire project
  package-lock.json             # Lock file (required by NodejsFunction)
  tsconfig.json                 # Base tsconfig
  tsconfig.cdk.json             # CDK-specific tsconfig (extends base)
  infra/
    app.ts                      # CDK app entry point
    stacks/
      homeops-stack.ts          # Main stack definition
    constructs/
      ingestion-api.ts          # API Gateway + Ingest Lambda grouping
      message-processing.ts     # SQS + Worker Lambda + DLQ grouping
      message-store.ts          # DynamoDB table construct
  src/
    handlers/
      ingest/
        index.ts                # Ingest Lambda handler entry point
        validator.ts            # Telegram update validation logic
      worker/
        index.ts                # Worker Lambda handler entry point
        dynamo-writer.ts        # DynamoDB write logic
      health/
        index.ts                # Health check handler (optional, can be inline)
    shared/
      types/
        telegram.ts             # Telegram Bot API types
        dynamo.ts               # DynamoDB record types
        events.ts               # SQS message envelope types
      utils/
        logger.ts               # Structured JSON logger
        secrets.ts              # Secrets Manager helper with caching
  test/
    infra/
      homeops-stack.test.ts     # Stack snapshot + assertion tests
    handlers/
      ingest/
        index.test.ts           # Ingest Lambda unit tests
        validator.test.ts       # Validation logic unit tests
      worker/
        index.test.ts           # Worker Lambda unit tests
    shared/
      utils/
        logger.test.ts          # Logger unit tests
```

### Key Principles

1. **`/infra` is CDK-only** -- stack definitions, constructs, and the CDK app entry point. No runtime code.
2. **`/src` is runtime-only** -- Lambda handlers and shared runtime code. No CDK imports.
3. **`/test` mirrors source** -- test directory structure mirrors both `/infra` and `/src`.
4. **Shared code lives in `/src/shared`** -- esbuild resolves imports from shared modules and bundles them into each Lambda automatically.
5. **Each handler gets its own directory** -- even if it is a single file now, this allows growth without restructuring.

### Why This Layout

The `NodejsFunction` construct points directly to handler entry files (e.g., `src/handlers/ingest/index.ts`). esbuild follows all imports from that entry point and bundles everything needed, including shared types and utilities. No manual bundling configuration or Lambda layers needed for shared code.

---

## 2. Package Management

### Recommendation: Single `package.json` at Root

For a project with 2-3 Lambda functions and a CDK app, a single `package.json` is strongly preferred over a workspace setup.

**Why not workspaces:**
- With only 2 Lambdas and shared types, workspaces add configuration overhead (package linking, hoisting issues, separate `node_modules`) without meaningful benefit.
- `NodejsFunction` with esbuild handles dependency isolation at bundle time -- each Lambda gets only the code it imports, regardless of what is installed at root.
- Workspaces become valuable at 10+ Lambda functions or when teams own different packages.

### Dependency Separation Strategy

```json
{
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.x",
    "@aws-sdk/lib-dynamodb": "^3.x",
    "@aws-sdk/client-sqs": "^3.x",
    "@aws-sdk/client-secrets-manager": "^3.x"
  },
  "devDependencies": {
    "aws-cdk-lib": "^2.x",
    "aws-cdk": "^2.x",
    "constructs": "^10.x",
    "esbuild": "^0.x",
    "typescript": "^5.x",
    "@types/aws-lambda": "^8.x",
    "@types/node": "^22.x",
    "vitest": "^2.x"
  }
}
```

**Key insight:** Even though `@aws-sdk/*` packages are listed in `dependencies`, they are not necessarily shipped to Lambda. The bundling configuration (see Section 3) controls whether the SDK is bundled into the Lambda or excluded to use the runtime-provided version.

### Tree-Shaking Implications

esbuild performs tree-shaking at bundle time. Even if every AWS SDK client is installed at root, only the specific clients and methods imported by each handler end up in its bundle. This makes the single `package.json` approach safe -- there is no "fat bundle" risk.

---

## 3. Lambda Bundling with esbuild

### How `NodejsFunction` Bundling Works

The `NodejsFunction` construct automatically:
1. Uses esbuild to transpile TypeScript to JavaScript
2. Follows all imports from the entry point
3. Tree-shakes unused code
4. Produces a single bundled `.js` file (or a few files with code splitting)
5. Packages the result as a Lambda deployment asset

No separate `tsc` compilation step is needed for Lambda handlers.

### Recommended Bundling Configuration

```typescript
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';

const ingestFn = new NodejsFunction(this, 'IngestFunction', {
  entry: 'src/handlers/ingest/index.ts',
  handler: 'handler',
  runtime: Runtime.NODEJS_22_X,
  architecture: Architecture.ARM_64,
  memorySize: 256,
  timeout: Duration.seconds(10),
  bundling: {
    // Bundle the AWS SDK instead of using runtime-provided version.
    // This enables tree-shaking of SDK v3, reducing cold starts.
    externalModules: [],

    // Minify for smaller bundles
    minify: true,

    // Source maps for debugging in CloudWatch
    sourceMap: true,
    sourceMapMode: SourceMapMode.INLINE,
    sourcesContent: false,

    // ESM format for better tree-shaking and smaller bundles
    format: OutputFormat.ESM,
    mainFields: ['module', 'main'],

    // Required banner for ESM compatibility with require() calls
    banner:
      "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",

    // Target Node.js 22
    target: 'node22',

    // Enable NODE_OPTIONS for source maps
    environment: {
      NODE_OPTIONS: '--enable-source-maps',
    },
  },
});
```

### Bundling vs External: The SDK Decision

There are two approaches for the AWS SDK:

| Approach | Config | Bundle Size | Cold Start | Version Control |
|----------|--------|-------------|------------|-----------------|
| **Bundle SDK** (recommended) | `externalModules: []` | Larger (~100-300KB) | Faster (tree-shaken) | Pinned to your package.json |
| **Use runtime SDK** | `externalModules: ['@aws-sdk/*']` | Smaller | Slower (loads full SDK) | Whatever AWS provides |

**Recommendation: Bundle the SDK.** When bundled with esbuild and tree-shaking, only the specific SDK clients and methods you use are included. This produces faster cold starts (up to 91ms improvement) and gives you version control over the SDK.

### Source Maps

Source maps are essential for debugging Lambda errors in CloudWatch. With `sourceMap: true` and `sourceMapMode: SourceMapMode.INLINE`:
- Stack traces in CloudWatch show original TypeScript line numbers
- The `NODE_OPTIONS: '--enable-source-maps'` environment variable must be set
- `sourcesContent: false` keeps the source map small (no embedded source code)

---

## 4. Shared Types

### Pattern: Shared `/src/shared/types` Directory

Types shared between Lambda handlers and potentially referenced by CDK code live in `/src/shared/types/`.

```typescript
// src/shared/types/telegram.ts
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  // ... other update types
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}
```

```typescript
// src/shared/types/dynamo.ts
export interface MessageRecord {
  chatId: string;       // PK - string representation of chat.id
  messageId: number;    // SK - message_id from Telegram
  userId: number;
  userName: string;
  text: string;
  timestamp: number;    // Unix ms
  raw: string;          // Full Telegram update JSON
  createdAt: string;    // ISO 8601
}
```

```typescript
// src/shared/types/events.ts
export interface IngestSqsMessage {
  telegramUpdate: TelegramUpdate;
  receivedAt: string;  // ISO 8601
}
```

### How Sharing Works with esbuild

When a Lambda handler imports from `../shared/types/telegram`, esbuild follows that import and includes the type definitions in the bundle. Since TypeScript types are erased at compile time, only runtime values (interfaces become nothing, enums become objects) affect bundle size. Pure type imports add zero bytes to the bundle.

### CDK Code Referencing Types

CDK code in `/infra` can also import types from `/src/shared/types/` for consistency (e.g., when defining DynamoDB attribute names). The `tsconfig.cdk.json` must include `/src/shared` in its path resolution. However, CDK code should never import runtime utilities -- only type definitions.

---

## 5. Environment Variables and Secrets

### Passing Environment Variables in CDK

```typescript
const fn = new NodejsFunction(this, 'WorkerFunction', {
  entry: 'src/handlers/worker/index.ts',
  environment: {
    TABLE_NAME: table.tableName,
    QUEUE_URL: queue.queueUrl,
    // Pass ARN, NOT the secret value
    BOT_TOKEN_SECRET_ARN: botTokenSecret.secretArn,
    LOG_LEVEL: 'INFO',
  },
});
```

**Rules:**
- Resource names/ARNs/URLs: pass as environment variables (they are not sensitive)
- Secret values (tokens, API keys): NEVER pass as environment variables -- pass the ARN and fetch at runtime

### Secrets Manager: Runtime Fetch with Caching

**Recommended approach:** Fetch secrets at runtime using the SDK, cache in module scope for Lambda warm starts.

```typescript
// src/shared/utils/secrets.ts
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});
const cache = new Map<string, { value: string; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getSecret(secretArn: string): Promise<string> {
  const now = Date.now();
  const cached = cache.get(secretArn);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  const value = response.SecretString!;
  cache.set(secretArn, { value, expiresAt: now + TTL_MS });
  return value;
}
```

**Why runtime fetch over environment variables:**
1. Secret values in environment variables appear in CloudFormation templates and the Lambda console
2. Environment variables are visible to anyone with `lambda:GetFunctionConfiguration` permission
3. Runtime fetching with caching adds minimal latency (~50ms on cold start, 0ms on warm)
4. You control cache TTL for secret rotation scenarios

**Alternative: AWS Parameters and Secrets Lambda Extension**

CDK has built-in support via `ParamsAndSecretsLayerVersion`:

```typescript
import { ParamsAndSecretsLayerVersion, ParamsAndSecretsVersions } from 'aws-cdk-lib/aws-lambda';

const paramsAndSecrets = ParamsAndSecretsLayerVersion.fromVersion(
  ParamsAndSecretsVersions.V1_0_103,
  {
    cacheSize: 500,
    logLevel: ParamsAndSecretsLogLevel.INFO,
  }
);

const fn = new NodejsFunction(this, 'IngestFunction', {
  // ...
  paramsAndSecrets,
});
```

This extension runs as a sidecar process, caches secrets automatically (default 300s TTL), and serves them via a local HTTP endpoint. However, it adds ~60ms to cold start for the extension initialization. For a project with only 2 Lambdas, the simple SDK caching approach is lighter weight.

### CDK IAM Grant Pattern

```typescript
// Grant the Lambda permission to read the secret
botTokenSecret.grantRead(ingestFn);

// This is equivalent to adding secretsmanager:GetSecretValue
// and kms:Decrypt (if using CMK) to the Lambda's execution role
```

---

## 6. Stack Organization

### Recommendation: Single Stack for Phase 1

For a project with API Gateway + 2 Lambdas + SQS + DLQ + DynamoDB + Secrets Manager + CloudWatch, a single stack is the right choice.

**Why single stack:**
- All resources are tightly coupled (Lambda needs SQS URL, DynamoDB table name, etc.)
- Fewer than 50 resources -- well within CloudFormation's 500-resource limit
- Simpler deployment: one `cdk deploy` command
- No cross-stack references to manage
- No circular dependency risk

**When to split (not now, but in future phases):**
- If DynamoDB table design changes rarely but Lambda code changes often
- If you want to protect stateful resources (DynamoDB) from accidental deletion during stateless resource updates
- Phase 2+ might warrant a `StatefulStack` (DynamoDB, Secrets) and `ApplicationStack` (API Gateway, Lambdas, SQS)

### Construct Organization Within the Stack

Even within a single stack, organize related resources into logical construct groupings:

```typescript
// infra/stacks/homeops-stack.ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { IngestionApi } from '../constructs/ingestion-api';
import { MessageProcessing } from '../constructs/message-processing';
import { MessageStore } from '../constructs/message-store';

export class HomeOpsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const store = new MessageStore(this, 'MessageStore');

    const processing = new MessageProcessing(this, 'MessageProcessing', {
      table: store.table,
    });

    const api = new IngestionApi(this, 'IngestionApi', {
      queue: processing.queue,
    });
  }
}
```

### Custom Constructs: L2 Wrappers, Not L3 Patterns

For this project, create simple grouping constructs that compose L2 constructs. These are not opinionated L3 patterns -- they are organizational units.

```typescript
// infra/constructs/message-processing.ts
import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';

interface MessageProcessingProps {
  table: ITable;
}

export class MessageProcessing extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly workerFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: MessageProcessingProps) {
    super(scope, id);

    this.dlq = new sqs.Queue(this, 'DLQ', {
      retentionPeriod: Duration.days(14),
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      visibilityTimeout: Duration.seconds(30),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3,
      },
    });

    this.workerFn = new NodejsFunction(this, 'WorkerFunction', {
      entry: 'src/handlers/worker/index.ts',
      // ... bundling config
      environment: {
        TABLE_NAME: props.table.tableName,
      },
    });

    this.workerFn.addEventSource(new SqsEventSource(this.queue, {
      batchSize: 1,
    }));

    props.table.grantWriteData(this.workerFn);
  }
}
```

---

## 7. Testing Patterns

### Test Directory Structure

```
test/
  infra/
    homeops-stack.test.ts      # Snapshot test + fine-grained assertions
    __snapshots__/             # Jest/Vitest snapshot files
  handlers/
    ingest/
      index.test.ts            # Handler integration test (mocked AWS)
      validator.test.ts        # Pure unit test for validation logic
    worker/
      index.test.ts            # Handler test with mocked DynamoDB
  shared/
    utils/
      logger.test.ts
      secrets.test.ts          # Mocked SecretsManagerClient
  helpers/
    fixtures.ts                # Shared test fixtures (Telegram updates, etc.)
```

### CDK Snapshot Tests

```typescript
// test/infra/homeops-stack.test.ts
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { HomeOpsStack } from '../../infra/stacks/homeops-stack';

test('snapshot test', () => {
  const app = new App();
  const stack = new HomeOpsStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // Use a custom serializer to strip Lambda code hashes
  // so handler code changes don't break infra snapshots
  expect(template.toJSON()).toMatchSnapshot();
});
```

**Important caveat:** Snapshot tests break when Lambda handler code changes because the asset hash changes. Use a custom serializer to strip `S3Key` and `S3ObjectVersion` from the snapshot, or rely on fine-grained assertions instead.

### Fine-Grained Assertion Tests

```typescript
test('creates DynamoDB table with correct keys', () => {
  const app = new App();
  const stack = new HomeOpsStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [
      { AttributeName: 'chatId', KeyType: 'HASH' },
      { AttributeName: 'messageId', KeyType: 'RANGE' },
    ],
  });
});

test('SQS queue has DLQ configured with maxReceiveCount 3', () => {
  template.hasResourceProperties('AWS::SQS::Queue', {
    RedrivePolicy: {
      maxReceiveCount: 3,
    },
  });
});

test('Worker Lambda has DynamoDB write permissions', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['dynamodb:PutItem']),
        }),
      ]),
    },
  });
});
```

### Lambda Handler Unit Tests

```typescript
// test/handlers/ingest/validator.test.ts
import { describe, it, expect } from 'vitest';
import { isValidTelegramUpdate } from '../../../src/handlers/ingest/validator';

describe('isValidTelegramUpdate', () => {
  it('accepts valid text message update', () => {
    const update = {
      update_id: 123,
      message: {
        message_id: 456,
        chat: { id: -100123, type: 'group' },
        from: { id: 789, is_bot: false, first_name: 'Test' },
        date: 1700000000,
        text: 'Hello',
      },
    };
    expect(isValidTelegramUpdate(update)).toBe(true);
  });

  it('rejects update without message', () => {
    const update = { update_id: 123, edited_message: { /* ... */ } };
    expect(isValidTelegramUpdate(update)).toBe(false);
  });
});
```

### Testing Strategy Summary

| Test Type | What It Tests | When to Use | Tool |
|-----------|--------------|-------------|------|
| **Snapshot** | Full CloudFormation template | Catch unintended infra drift | Vitest/Jest |
| **Fine-grained assertion** | Specific resource properties | Verify security, config | CDK assertions |
| **Handler unit test** | Business logic (validation, transforms) | All handler logic | Vitest |
| **Handler integration test** | Handler with mocked AWS SDK | End-to-end handler flow | Vitest + aws-sdk-client-mock |
| **E2E test** | Deployed stack | Post-deploy verification | Custom scripts |

---

## 8. Cold Start Optimization

### Runtime Choice: Node.js 22

**Recommendation: Use Node.js 22 (`NODEJS_22_X`).**

- Node.js 20 EOL in Lambda: April 30, 2026 (only 2 months away)
- Node.js 22 EOL in Lambda: April 30, 2027
- Node.js 22 has ~50ms higher baseline cold start than Node.js 20, but this is offset by the optimizations below
- Node.js 22 runs faster at runtime (execution speed, not init)

### Architecture: ARM64

Use `Architecture.ARM_64` (Graviton2/3):
- 20% cheaper than x86_64
- Generally faster cold starts and execution
- Available in eu-north-1

### Cold Start Budget for This Project

Target: <2s end-to-end (webhook receipt to DB write). Cold start breakdown:

| Component | Estimated Time |
|-----------|---------------|
| Lambda init (runtime) | ~100ms |
| Code load (bundled, tree-shaken) | ~150-250ms |
| First SDK call overhead | ~100-125ms |
| Secrets fetch (cold, if needed) | ~50-100ms |
| **Total cold start** | **~400-575ms** |

This is well within the 2s target even with cold starts.

### Bundle Size Optimization

```typescript
bundling: {
  // Bundle SDK for tree-shaking
  externalModules: [],

  // ESM format for better tree-shaking
  format: OutputFormat.ESM,
  mainFields: ['module', 'main'],

  // Minify to reduce bundle size
  minify: true,

  // Target specific Node.js version
  target: 'node22',

  // Remove unused credential providers (saves ~40ms cold start)
  // These are unnecessary in Lambda (only env credential provider is used)
  // Note: this is optional and aggressive -- test thoroughly
  // externalModules: [
  //   '@aws-sdk/client-sso',
  //   '@aws-sdk/client-sso-oidc',
  //   '@smithy/credential-provider-imds',
  // ],
}
```

### Keeping Functions Small

The ingest Lambda should be minimal:
- Validate incoming JSON structure
- Publish to SQS
- Return 200

It should NOT:
- Fetch secrets (unless validating Telegram secret token)
- Connect to DynamoDB
- Do heavy processing

This keeps the ingest Lambda's bundle small and cold start fast, which matters for webhook responsiveness.

### eu-north-1 Considerations

No special cold start behavior for eu-north-1. The region has full Lambda support including ARM64 (Graviton). Cold starts may be marginally different from us-east-1 due to fewer pre-warmed execution environments, but this is negligible for low-traffic applications.

---

## 9. tsconfig Setup

### Recommendation: Base tsconfig + CDK Extension

Use a base `tsconfig.json` with shared settings and a `tsconfig.cdk.json` that extends it for CDK compilation.

```jsonc
// tsconfig.json (base -- used by esbuild for Lambda handlers)
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": ".",
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

```jsonc
// tsconfig.cdk.json (CDK compilation)
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist/infra",
    "rootDir": "."
  },
  "include": ["infra/**/*", "src/shared/types/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### Why Two tsconfigs

1. **Lambda code (`tsconfig.json`)**: esbuild uses this for path resolution and type checking context. esbuild does NOT use `tsc` -- it does its own transpilation. But your IDE and `tsc --noEmit` type checking use this config.

2. **CDK code (`tsconfig.cdk.json`)**: CDK needs to be compiled with `tsc` (the `cdk` CLI runs compiled JS). The CDK tsconfig includes `infra/` and shared types from `src/shared/types/` but excludes Lambda handler code.

### cdk.json Configuration

```jsonc
// cdk.json
{
  "app": "npx ts-node --project tsconfig.cdk.json infra/app.ts",
  "watch": {
    "include": ["infra/**", "src/**"],
    "exclude": ["node_modules", "dist", "test"]
  },
  "context": {
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true,
    "@aws-cdk/core:stackRelativeExports": true
  }
}
```

**Note:** Using `ts-node` with `--project tsconfig.cdk.json` allows running the CDK app directly from TypeScript without a separate build step. Alternatively, you can use `tsx` as the ts-node replacement for ESM compatibility:

```jsonc
{
  "app": "npx tsx infra/app.ts"
}
```

### Path Aliases

The `@shared/*` path alias in `tsconfig.json` allows clean imports:

```typescript
// src/handlers/ingest/index.ts
import { TelegramUpdate } from '@shared/types/telegram';
import { logger } from '@shared/utils/logger';
```

**Important:** esbuild respects `tsconfig.json` paths for resolution. However, if using path aliases, you need to ensure the `NodejsFunction` construct's `tsconfig` bundling option points to the correct tsconfig:

```typescript
new NodejsFunction(this, 'IngestFunction', {
  entry: 'src/handlers/ingest/index.ts',
  bundling: {
    tsconfig: 'tsconfig.json',
    // ... other options
  },
});
```

---

## Recommendations for HomeOps Phase 1

### Concrete Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Directory structure** | `/infra`, `/src`, `/test` flat layout | Matches PRD. Simple, no workspaces needed. |
| **Package management** | Single `package.json` at root | 2 Lambdas + CDK is too small for workspaces. esbuild handles isolation. |
| **Lambda bundling** | `NodejsFunction` with esbuild, ESM, minified, source maps | Best cold start performance. Tree-shakes SDK v3. |
| **AWS SDK** | Bundle it (`externalModules: []`) | Enables tree-shaking. Pins SDK version. Faster cold starts. |
| **Shared types** | `/src/shared/types/` directory | esbuild bundles shared imports automatically. Zero config. |
| **Secrets** | Runtime SDK fetch with module-scope caching (5min TTL) | Simpler than Lambda extension. Secure. Good enough for 2 Lambdas. |
| **Stack count** | Single stack | Project is small. All resources are coupled. Split in Phase 2+ if needed. |
| **Construct organization** | 3 grouping constructs (IngestionApi, MessageProcessing, MessageStore) | Keeps stack file clean. Logical separation. Easy to test individually. |
| **Runtime** | Node.js 22 ARM64 | Node.js 20 EOL is April 2026. ARM64 is cheaper and faster. |
| **Testing framework** | Vitest | Faster than Jest. Good TypeScript support. Compatible with CDK assertions. |
| **Testing strategy** | Fine-grained CDK assertions + handler unit tests | Skip snapshots initially (they break on handler changes). Add later. |
| **tsconfig** | Base `tsconfig.json` + `tsconfig.cdk.json` extension | Separates concerns. esbuild and IDE use base. CDK uses extension. |

---

## Trade-offs

| Decision | What You Give Up |
|----------|-----------------|
| Single `package.json` | Cannot deploy Lambdas independently; cannot have different dependency versions per Lambda |
| Bundle SDK | Slightly larger bundle than using runtime SDK (mitigated by tree-shaking) |
| Single stack | Cannot deploy stateful/stateless resources independently; full redeploy on any change |
| No Lambda layers | Shared code is duplicated in each bundle (but bundles are small, so this is negligible) |
| Runtime secrets fetch | ~50-100ms cold start penalty for first invocation; small Secrets Manager API cost |
| ESM format | May encounter edge cases with CJS-only npm packages (rare with SDK v3) |
| Skip snapshot tests initially | Less protection against unintended infra drift (mitigated by fine-grained assertions) |

---

## Open Questions

1. **Test framework confirmation:** The PRD does not specify a test framework. Vitest is recommended over Jest for faster execution and native TypeScript support, but this should be confirmed.

2. **Path aliases vs relative imports:** Path aliases (`@shared/...`) require additional configuration. Relative imports (`../../shared/...`) work out of the box. The project should decide which style to use.

3. **CDK app runner:** `ts-node` vs `tsx` for running the CDK app. `tsx` is newer and handles ESM better, but `ts-node` is more established in CDK documentation.

4. **Vitest compatibility with CDK assertions:** The `aws-cdk-lib/assertions` module is designed for Jest but works with Vitest. Confirm there are no edge cases with snapshot serializers.

5. **Single-table vs multi-table DynamoDB:** The PRD mentions this should be researched. This is a separate research question but affects the `MessageStore` construct design.

6. **Memory size for Lambdas:** 256MB is a common default but the optimal size depends on workload. Consider running Lambda Power Tuning after deployment to right-size.

---

## Sources

- [AWS CDK NodejsFunction documentation](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html)
- [AWS CDK Testing documentation](https://docs.aws.amazon.com/cdk/v2/guide/testing.html)
- [AWS CDK Best Practices - Construct organization](https://docs.aws.amazon.com/prescriptive-guidance/latest/best-practices-cdk-typescript-iac/constructs-best-practices.html)
- [The Fastest Node 22 Lambda Coldstart Configuration](https://speedrun.nobackspacecrew.com/blog/2025/07/21/the-fastest-node-22-lambda-coldstart-configuration.html)
- [Optimizing Node.js Dependencies in AWS Lambda](https://aws.amazon.com/blogs/compute/optimizing-node-js-dependencies-in-aws-lambda/)
- [Reduce Lambda cold start times: migrate to AWS SDK for JavaScript v3](https://aws.amazon.com/blogs/developer/reduce-lambda-cold-start-times-migrate-to-aws-sdk-for-javascript-v3/)
- [AWS Secrets Manager in Lambda Functions](https://docs.aws.amazon.com/lambda/latest/dg/with-secrets-manager.html)
- [ParamsAndSecretsLayerVersion CDK API](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda.ParamsAndSecretsLayerVersion.html)
- [CDK TypeScript Lambda - aws-samples](https://github.com/aws-samples/cdk-typescript-lambda)
- [TypeScript Monorepo Setup with AWS CDK](https://martijn-sturm.hashnode.dev/typescript-monorepo-aws-infra-lambdas-cdk)
- [AWS CDK Snapshot Tests Guide](https://wempe.dev/blog/aws-cdk-snapshot-tests)
- [CDK Single Stack vs Multiple Stacks Discussion](https://github.com/aws/aws-cdk/discussions/34097)
- [Node.js Lambda Package Optimization with ES Modules](https://www.levi9.com/whitepaper/node-js-lambda-package-optimization/)
