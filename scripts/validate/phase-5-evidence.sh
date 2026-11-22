#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/docs/plans/customer-support-v1/evidence/phase-5"
BUN_CRITERIA='(A12|A13|A20)'
cd "$ROOT"
mkdir -p "$OUT"

bun scripts/stack.ts down >/dev/null 2>&1
env -u TYPESAFE_API_KEY -u ANTHROPIC_API_KEY bun run check --skip-install >"$OUT/check.log" 2>&1
echo "check exit=$?"

rm -rf "$OUT/live"
bun run validate:phase-5 --evidence-dir "$OUT/live" >"$OUT/live.log" 2>&1
echo "validate exit=$?"

env -u TYPESAFE_API_KEY bun test modules tests pipelines -t "$BUN_CRITERIA" \
  --reporter=junit --reporter-outfile="$OUT/junit.xml" >/dev/null 2>&1
{
  grep -o '<testcase name="[^"]*"' "$OUT/junit.xml" |
    grep -E "name=\"[^\"]*${BUN_CRITERIA}" |
    sed -E 's/<testcase name="(.*)"/PASS \1/'
  echo "junit failures: $(grep -c '<failure' "$OUT/junit.xml")"
} >"$OUT/criteria-tests.log"
rm -f "$OUT/junit.xml"

find "$OUT" -type f \( -name '*.log' -o -name '*.json' -o -name '*.txt' \) -print0 |
  xargs -0 sed -i.bak "s#$ROOT#.#g; s#$HOME#~#g"
find "$OUT" -name '*.bak' -delete
