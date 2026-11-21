#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/docs/plans/customer-support-v1/evidence/phase-2"
CRITERIA='^A(3|5|6|7|8|9|10|11|27) '
cd "$ROOT"
mkdir -p "$OUT"

env -u TYPESAFE_API_KEY -u ANTHROPIC_API_KEY bun run check --skip-install >"$OUT/check.log" 2>&1
echo "check exit=$?"

bun test modules/triage -t corpus >"$OUT/corpus.log" 2>&1
echo "corpus exit=$?"

MODE=()
[ -z "${ANTHROPIC_API_KEY:-}" ] && MODE=(--partial)
VALIDATE_TIME_FACTOR="${VALIDATE_TIME_FACTOR:-0.14}" bun run validate:phase-2 "${MODE[@]}" >"$OUT/live.log" 2>&1
echo "validate exit=$?"

env -u TYPESAFE_API_KEY bun test modules pipelines -t "$CRITERIA" \
  --reporter=junit --reporter-outfile="$OUT/junit.xml" >/dev/null 2>&1
grep -o '<testcase name="[^"]*"' "$OUT/junit.xml" |
  grep -E "name=\"${CRITERIA#^}" |
  sed -E 's/<testcase name="(.*)"/PASS \1/' >"$OUT/criteria-tests.log"
echo "junit failures: $(grep -c '<failure' "$OUT/junit.xml")" >>"$OUT/criteria-tests.log"
rm -f "$OUT/junit.xml"

sed -i.bak "s#$ROOT#.#g; s#$HOME#~#g" "$OUT"/*.log
rm -f "$OUT"/*.bak
