#!/usr/bin/env bash
set -euo pipefail

PORT="${SMOKE_API_PORT:-8799}"
BASE="http://127.0.0.1:${PORT}"

API_PORT="$PORT" bun run dev:api >/dev/null 2>&1 &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -sf "$BASE/health" >/dev/null && break
  sleep 0.25
done

seed_key() {
  SEED_CLIENT_SLUG="$1" SEED_PROJECT_SLUG="$2" SEED_PROJECT_KEY="$3" bun run seed:dev >/dev/null 2>&1
  printf '%s' "$3"
}

KEY_A="$(seed_key acme portal "smoke-key-a-$$")"
KEY_B="$(seed_key globex shop "smoke-key-b-$$")"
HASH_B="$(printf '%s' "bob@example.com${KEY_B}" | shasum -a 256 | cut -d' ' -f1)"

status() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

echo "POST /v1/requests as project B -> $(status -H "X-Support-Key: $KEY_B" -H "X-Support-User: $HASH_B" -F text='B private request' "$BASE/v1/requests")"
OWN="$(curl -s -H "X-Support-Key: $KEY_B" -H "X-Support-User: $HASH_B" "$BASE/v1/requests")"
echo "GET /v1/requests as project B -> contains private request: $(printf '%s' "$OWN" | grep -c 'B private request' || true)"
CROSS="$(curl -s -H "X-Support-Key: $KEY_A" -H "X-Support-User: $HASH_B" "$BASE/v1/requests")"
echo "A17 GET /v1/requests with key A and hash B -> body: $CROSS"
echo "A17 body contains private request: $(printf '%s' "$CROSS" | grep -c 'B private request' || true)"
echo "GET /v1/requests with unknown key -> $(status -H 'X-Support-Key: nope' -H "X-Support-User: $HASH_B" "$BASE/v1/requests")"
