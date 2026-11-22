#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/docs/plans/customer-support-v1/evidence/phase-6"
cd "$ROOT"
mkdir -p "$OUT"

bun scripts/stack.ts down >/dev/null 2>&1
env -u TYPESAFE_API_KEY -u ANTHROPIC_API_KEY bun run check --skip-install >"$OUT/check.log" 2>&1
echo "check exit=$?"

bun run validate:release >"$OUT/release.log" 2>&1
echo "release exit=$?"

bun run validate:deploy >"$OUT/deploy.log" 2>&1
echo "deploy exit=$?"

bun run build:plugin >"$OUT/plugin.log" 2>&1
echo "plugin build exit=$?"

bun test scripts -t "skill" >"$OUT/skills-audit.log" 2>&1
echo "skills audit exit=$?"

find "$OUT" -type f -name '*.log' -print0 |
  xargs -0 sed -i.bak "s#$ROOT#.#g; s#$HOME#~#g"
find "$OUT" -name '*.bak' -delete
