#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/docs/plans/customer-support-v1/evidence/phase-3"
CRITERIA='^A(14|15|16) '
cd "$ROOT"
mkdir -p "$OUT/screenshots"

bun scripts/stack.ts down >/dev/null 2>&1
env -u TYPESAFE_API_KEY -u ANTHROPIC_API_KEY bun run check --skip-install >"$OUT/check.log" 2>&1
echo "check exit=$?"

bun run validate:phase-3 >"$OUT/live.log" 2>&1
echo "validate exit=$?"

env -u TYPESAFE_API_KEY bun test modules tests pipelines -t "$CRITERIA" \
  --reporter=junit --reporter-outfile="$OUT/junit.xml" >/dev/null 2>&1
grep -o '<testcase name="[^"]*"' "$OUT/junit.xml" |
  grep -E "name=\"${CRITERIA#^}" |
  sed -E 's/<testcase name="(.*)"/PASS \1/' >"$OUT/criteria-tests.log"
echo "junit failures: $(grep -c '<failure' "$OUT/junit.xml")" >>"$OUT/criteria-tests.log"
rm -f "$OUT/junit.xml"

cp "$ROOT"/e2e/artifacts/a14-*.png "$ROOT"/e2e/artifacts/a15-*.png "$ROOT"/e2e/artifacts/a16-*.png "$OUT/screenshots/" 2>/dev/null

sed -i.bak "s#$ROOT#.#g; s#$HOME#~#g" "$OUT"/*.log
rm -f "$OUT"/*.bak
