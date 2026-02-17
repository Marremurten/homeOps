# HomeOps

A Telegram bot for tracking household contributions. Family members report chores or rest in Swedish, and the bot classifies, stores, and acknowledges them — building a shared log of who did what around the house.

## How It Works

1. A family member sends a message to the Telegram bot (e.g. "Jag har diskat")
2. The message is ingested via API Gateway and queued in SQS
3. A worker Lambda classifies the message using OpenAI (chore, recovery, or neither)
4. Classified activities are stored in DynamoDB
5. The bot replies with an acknowledgment if the response policy allows it

The response policy prevents spam by enforcing quiet hours (Stockholm timezone), a daily cap, cooldown between responses, and confidence thresholds.

## Tech Stack

- **Language**: TypeScript (ESM)
- **Infrastructure**: AWS CDK
- **Runtime**: AWS Lambda (Node.js 22)
- **Queue**: Amazon SQS
- **Database**: Amazon DynamoDB
- **AI**: OpenAI (gpt-4o-mini)
- **Region**: eu-north-1

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm
- AWS CLI configured with credentials
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An OpenAI API key

### Setup

```bash
pnpm install
```

Store your secrets in AWS Secrets Manager:

```bash
aws secretsmanager put-secret-value --secret-id homeops/telegram-bot-token --secret-string "YOUR_BOT_TOKEN" --region eu-north-1
aws secretsmanager put-secret-value --secret-id homeops/webhook-secret --secret-string "YOUR_WEBHOOK_SECRET" --region eu-north-1
aws secretsmanager put-secret-value --secret-id homeops/openai-api-key --secret-string "YOUR_OPENAI_KEY" --region eu-north-1
```

### Deploy

```bash
pnpm cdk deploy
```

### Register Telegram Webhook

After deploying, register the webhook with your API Gateway URL:

```bash
./scripts/register-webhook.sh https://YOUR_API_GATEWAY_URL
```

### Run Tests

```bash
pnpm test
```

## Project Structure

```
src/
  handlers/         Lambda handlers (ingest, worker, health)
  shared/
    services/       Business logic (classifier, activity-store, response-policy)
    types/          TypeScript type definitions
    utils/          Helpers (secrets caching, timezone, tone validation)
infra/              CDK stack and constructs
test/               Tests (mirrors src/ structure)
scripts/            Deployment helpers
```

## License

MIT
