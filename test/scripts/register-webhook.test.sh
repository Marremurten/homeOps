#!/usr/bin/env bash
# test/scripts/register-webhook.test.sh
#
# Tests for scripts/register-webhook.sh
# These tests validate argument handling, dependency checks, and help output.
# The actual Telegram API call is NOT tested (requires real credentials).

set -euo pipefail

SCRIPT_UNDER_TEST="$(cd "$(dirname "$0")/../.." && pwd)/scripts/register-webhook.sh"
PASS=0
FAIL=0

# ─── Helpers ──────────────────────────────────────────────────────────────────

pass() {
  PASS=$((PASS + 1))
  echo "  PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "  FAIL: $1"
  if [ -n "${2:-}" ]; then
    echo "        $2"
  fi
}

assert_exit_code() {
  local description="$1"
  local expected="$2"
  local actual="$3"
  if [ "$actual" -eq "$expected" ]; then
    pass "$description"
  else
    fail "$description" "expected exit code $expected, got $actual"
  fi
}

assert_stdout_contains() {
  local description="$1"
  local needle="$2"
  local haystack="$3"
  if echo "$haystack" | grep -qi "$needle"; then
    pass "$description"
  else
    fail "$description" "expected stdout to contain '$needle'"
  fi
}

assert_stderr_contains() {
  local description="$1"
  local needle="$2"
  local haystack="$3"
  if echo "$haystack" | grep -qi "$needle"; then
    pass "$description"
  else
    fail "$description" "expected stderr to contain '$needle'"
  fi
}

# ─── Precondition: script exists ─────────────────────────────────────────────

echo ""
echo "Testing: $SCRIPT_UNDER_TEST"
echo ""

if [ ! -f "$SCRIPT_UNDER_TEST" ]; then
  echo "SKIP: Script does not exist yet (expected for TDD). All tests would fail."
  echo ""
  echo "Results: 0 passed, 3 failed (script not found)"
  exit 1
fi

if [ ! -x "$SCRIPT_UNDER_TEST" ]; then
  fail "Script is not executable" "$SCRIPT_UNDER_TEST"
  echo ""
  echo "Results: $PASS passed, $((FAIL + 3)) failed"
  exit 1
fi

# ─── Test 1: Exits with error if no API Gateway URL argument is provided ─────

echo "--- Test 1: No arguments ---"

output=$(bash "$SCRIPT_UNDER_TEST" 2>&1 || true)
exit_code=0
bash "$SCRIPT_UNDER_TEST" >/dev/null 2>&1 || exit_code=$?

assert_exit_code "exits with non-zero when no arguments provided" 1 "$exit_code"

combined_output=$(bash "$SCRIPT_UNDER_TEST" 2>&1 || true)
assert_stdout_contains \
  "prints error or usage message when no arguments" \
  "usage\|url\|argument\|required" \
  "$combined_output"

# ─── Test 2: Exits with error if aws CLI is not available ────────────────────

echo "--- Test 2: Missing aws CLI ---"

# Run the script with a PATH that excludes aws, but provide a URL argument
# so the script gets past argument validation and into dependency checking.
exit_code=0
output=$(PATH="/usr/bin:/bin" bash "$SCRIPT_UNDER_TEST" "https://example.execute-api.eu-north-1.amazonaws.com/webhook" 2>&1 || true)
PATH="/usr/bin:/bin" bash "$SCRIPT_UNDER_TEST" "https://example.execute-api.eu-north-1.amazonaws.com/webhook" >/dev/null 2>&1 || exit_code=$?

assert_exit_code "exits with non-zero when aws CLI is not found" 1 "$exit_code"

combined_output=$(PATH="/usr/bin:/bin" bash "$SCRIPT_UNDER_TEST" "https://example.execute-api.eu-north-1.amazonaws.com/webhook" 2>&1 || true)
assert_stderr_contains \
  "prints error about missing aws CLI" \
  "aws\|cli\|command\|not found\|install" \
  "$combined_output"

# ─── Test 3: Prints usage instructions with --help ──────────────────────────

echo "--- Test 3: --help flag ---"

exit_code=0
help_output=$(bash "$SCRIPT_UNDER_TEST" --help 2>&1 || true)
bash "$SCRIPT_UNDER_TEST" --help >/dev/null 2>&1 || exit_code=$?

assert_exit_code "--help exits with code 0" 0 "$exit_code"

assert_stdout_contains \
  "--help mentions usage" \
  "usage" \
  "$help_output"

assert_stdout_contains \
  "--help mentions the API Gateway URL argument" \
  "url\|api.gateway\|endpoint\|api-gateway" \
  "$help_output"

assert_stdout_contains \
  "--help mentions webhook registration or Telegram" \
  "webhook\|telegram" \
  "$help_output"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

exit 0
