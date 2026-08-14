#!/usr/bin/env bash
# Test Demeter logs API on EC2.
#
# Usage (from repo root):
#   bash scripts/test-demeter-logs-api.sh
#   bash scripts/test-demeter-logs-api.sh https://agent.soterialabs.io

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${DEMETER_ENV_FILE:-$ROOT/.env}"
BASE="${1:-https://agent.soterialabs.io}"
BASE="${BASE%/}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FAIL: .env not found at $ENV_FILE"
  exit 1
fi

KEY="$(grep '^DEMETER_LOGS_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r"' | head -1)"
# Strip inline comments (match server parseDotEnvValue)
KEY="${KEY%% #*}"

if [[ -z "$KEY" || ${#KEY} -lt 16 ]]; then
  echo "FAIL: DEMETER_LOGS_API_KEY missing or too short in $ENV_FILE"
  exit 1
fi

curl_check() {
  local label="$1"
  shift
  echo "=== $label ==="
  local body http_code
  body="$(curl -sS "$@" -w $'\n__HTTP__%{http_code}')"
  http_code="${body##*__HTTP__}"
  body="${body%$'\n'__HTTP__*}"
  echo "$body"
  echo "HTTP $http_code"
  if [[ "$body" == *'"ok":true'* ]] || [[ "$body" == *'"entries"'* ]]; then
    echo "PASS"
  else
    echo "FAIL"
  fi
  echo ""
}

echo "Base URL: $BASE"
echo "Key length from .env: ${#KEY}"
echo ""

curl_check "auth-check via ?apiKey= (paste test — use single quotes around URL)" \
  "$BASE/api/demeter/auth-check?apiKey=$KEY"

curl_check "auth-check via X-Demeter-Logs-Key header" \
  -H "X-Demeter-Logs-Key: $KEY" \
  -H "Accept: application/json" \
  "$BASE/api/demeter/auth-check"

curl_check "auth-check via Authorization: Bearer" \
  -H "Authorization: Bearer $KEY" \
  -H "Accept: application/json" \
  "$BASE/api/demeter/auth-check"

curl_check "logs via ?apiKey=" \
  -H "Accept: application/json" \
  "$BASE/api/demeter/logs?stream=strategy&limit=2&apiKey=$KEY"
