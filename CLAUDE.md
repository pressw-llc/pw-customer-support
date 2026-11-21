# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The workspace `CLAUDE.md` one directory up applies here. It sets the shared PressW conventions: `bun` for every command, Biome for lint and format, and worktrees under `.claude/worktrees/<branch-name>`.

## Commands

Run these from the repository root. Use `bun` and `bunx` only.

```bash
bun install
bun run check                       # install, lint, typecheck, stack, test, synth
bun run check --skip-install
bun run lint                        # biome check and scripts/lint-boundaries.ts
bun run format
bun run typecheck                   # tsc across every module
bun test                            # all tests
bun test modules/db/src/db.test.ts  # single test file
bun run stack:up                    # Postgres 5447, LocalStack 4577
bun run stack:down
bun run db:migrate
bun run synth                       # cdk synth, no AWS credentials needed
```

`bun run check` leaves the Compose stack running. Integration tests use the real Compose Postgres and LocalStack, so start the stack before `bun test`. `bun install` needs `GITHUB_TOKEN` with `read:packages` for the `@pressw-llc` packages.

## Architecture

A Bun workspace with nine modules under `modules/*`. Packages are `@pw-support/<module>` and private, except `widget`, which is `@pressw-llc/support-react`.
- `contracts` holds the zod 3 schemas that every module shares.
- `db` owns the Postgres schema `support`, hand-written SQL migrations, and `appendEvent`. `migrations/pipeline/` holds the copied pipeline migrations. They run first.
- `api` serves a Hono app on Bun.
- `triage` pins `@pressw-llc/pipeline` and `@pressw-llc/managed-agents` to exact versions.
- `infra` defines the CDK stack in `us-east-1`.
- `widget`, `admin`, `channels`, and `plugin` are shells until their phases land.

A module imports another module only through `@pw-support/contracts` or another module's bare package name. `scripts/lint-boundaries.ts` enforces this inside `bun run lint`.

`events` is an append-only table. A trigger rejects UPDATE, DELETE, and TRUNCATE. Append events through `appendEvent`.

Coverage runs through `bun test --coverage` with an 85 percent line and function floor set in `bunfig.toml`.

This repository is public. Keep client names, client data, and real keys out of it. Use `acme` in fixtures.

## Delivery loop

Start work with `/delivery-loop:scope <branch>`. Use `/delivery-loop:activate` for planning or review with no worktree.

The delivery-loop skills own the methodology. Invoke them instead of re-deriving the process: `goal-prd`, `phased-plan`, `work`, `worktree-execution`, `adversarial-review-loop`, `live-validation`, `evidence-pr`, `debug-to-root-cause`.

Plans live under `docs/plans/<plan>/`. Each plan holds `PRD.md` and an `evidence/` directory.

Project settings live in `.delivery/config`. Template overrides live in `.delivery/templates/`. Both are committed. Session and run state is gitignored.
