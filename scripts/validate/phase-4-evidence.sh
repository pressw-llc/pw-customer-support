#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/docs/plans/customer-support-v1/evidence/phase-4"
BUN_CRITERIA='(A18|A19|A29|A15 admin)'
E2E_CRITERIA='A(15|18|19|29)'
cd "$ROOT"
mkdir -p "$OUT/screenshots"

bun scripts/stack.ts down >/dev/null 2>&1
env -u TYPESAFE_API_KEY -u ANTHROPIC_API_KEY bun run check --skip-install >"$OUT/check.log" 2>&1
echo "check exit=$?"

bun run validate:phase-4 >"$OUT/live.log" 2>&1
echo "validate exit=$?"

env -u TYPESAFE_API_KEY bun test modules tests pipelines -t "$BUN_CRITERIA" \
  --reporter=junit --reporter-outfile="$OUT/junit.xml" >/dev/null 2>&1
{
  grep -o '<testcase name="[^"]*"' "$OUT/junit.xml" |
    grep -E "name=\"[^\"]*${BUN_CRITERIA}" |
    sed -E 's/<testcase name="(.*)"/PASS \1/'
  echo "junit failures: $(grep -c '<failure' "$OUT/junit.xml")"
  echo "playwright tests:"
  bun run --filter @pw-support/e2e test --list --grep "$E2E_CRITERIA" 2>&1 |
    grep -E "admin\.spec\.ts" | sed -E 's/^.*(admin\.spec\.ts)/\1/'
} >"$OUT/criteria-tests.log"
rm -f "$OUT/junit.xml"

cp "$ROOT"/e2e/artifacts/admin-*.png "$OUT/screenshots/" 2>/dev/null

sed -i.bak "s#$ROOT#.#g; s#$HOME#~#g" "$OUT"/*.log
rm -f "$OUT"/*.bak
