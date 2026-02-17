#!/usr/bin/env bash
# scripts/register-webhook.sh
#
# Registers the Telegram webhook with the API Gateway endpoint.
#
# Usage:
#   ./scripts/register-webhook.sh <API_GATEWAY_URL>
#
# The script reads the bot token and webhook secret from AWS Secrets Manager,
# then calls the Telegram setWebhook API to register the webhook endpoint.
#
# Requirements:
#   - aws CLI installed and configured
#   - jq installed
#   - curl installed
#
# Environment:
#   BOT_TOKEN_SECRET_NAME    - Secrets Manager secret name for the bot token
#                              (default: homeops/telegram/bot-token)
#   WEBHOOK_SECRET_NAME      - Secrets Manager secret name for the webhook secret
#                              (default: homeops/telegram/webhook-secret)

set -euo pipefail

# ─── Constants ────────────────────────────────────────────────────────────────

BOT_TOKEN_SECRET_NAME="${BOT_TOKEN_SECRET_NAME:-homeops/telegram-bot-token}"
WEBHOOK_SECRET_NAME="${WEBHOOK_SECRET_NAME:-homeops/webhook-secret}"

# ─── Help ─────────────────────────────────────────────────────────────────────

show_help() {
  cat <<EOF
Usage: $(basename "$0") <API_GATEWAY_URL>

Register a Telegram webhook with the given API Gateway URL endpoint.

Arguments:
  API_GATEWAY_URL   The full URL of the API Gateway endpoint (e.g. https://abc123.execute-api.eu-north-1.amazonaws.com)

Options:
  --help            Show this help message and exit

The script reads the bot token and webhook secret from AWS Secrets Manager,
then calls the Telegram setWebhook API with:
  - url: <API_GATEWAY_URL>/webhook
  - secret_token: from Secrets Manager
  - allowed_updates: ["message"]
  - drop_pending_updates: true
  - max_connections: 10
EOF
}

# ─── Argument parsing ─────────────────────────────────────────────────────────

if [ "${1:-}" = "--help" ]; then
  show_help
  exit 0
fi

if [ $# -eq 0 ]; then
  echo "Error: API Gateway URL argument is required." >&2
  echo "" >&2
  echo "Usage: $(basename "$0") <API_GATEWAY_URL>" >&2
  exit 1
fi

API_GATEWAY_URL="$1"

# ─── Dependency checks ───────────────────────────────────────────────────────

if ! command -v aws &>/dev/null; then
  echo "Error: aws CLI is not installed or not in PATH." >&2
  echo "Install it from https://aws.amazon.com/cli/" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is not installed or not in PATH." >&2
  exit 1
fi

if ! command -v curl &>/dev/null; then
  echo "Error: curl is not installed or not in PATH." >&2
  exit 1
fi

# ─── Fetch secrets ────────────────────────────────────────────────────────────

echo "Fetching bot token from Secrets Manager..."
BOT_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id "$BOT_TOKEN_SECRET_NAME" \
  --query 'SecretString' \
  --output text)

echo "Fetching webhook secret from Secrets Manager..."
WEBHOOK_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id "$WEBHOOK_SECRET_NAME" \
  --query 'SecretString' \
  --output text)

# ─── Register webhook ────────────────────────────────────────────────────────

WEBHOOK_URL="${API_GATEWAY_URL}/webhook"

echo "Registering Telegram webhook at: $WEBHOOK_URL"

RESPONSE=$(curl -s -X POST \
  "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WEBHOOK_URL}\",
    \"secret_token\": \"${WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\"],
    \"drop_pending_updates\": true,
    \"max_connections\": 10
  }")

# ─── Check result ─────────────────────────────────────────────────────────────

OK=$(echo "$RESPONSE" | jq -r '.ok')

if [ "$OK" = "true" ]; then
  echo "Webhook registered successfully."
  echo "$RESPONSE" | jq .
else
  echo "Error: Failed to register webhook." >&2
  echo "$RESPONSE" | jq . >&2
  exit 1
fi
