# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The workspace `CLAUDE.md` one directory up applies here. It sets the shared PressW conventions: `bun` for every command, Biome for lint and format, and worktrees under `.claude/worktrees/<branch-name>`.

## Commands

Run these from the repository root. Use `bun` and `bunx` only.

```bash
bun install
bun run check                       # install, lint, build, typecheck, stack, test, e2e, synth
bun run check --skip-install
bun run lint                        # biome check and scripts/lint-boundaries.ts
bun run format
bun run build                       # widget dist: ESM, d.ts, global browser bundle
bun run typecheck                   # tsc across modules, example app, and e2e
bun run test                        # root tests, then widget tests under happy-dom
bun test modules/db/src/db.test.ts  # single root test file
bun run e2e                         # Playwright, starts the API and the example app
bun run stack:up                    # Postgres and LocalStack, ports from .env.local
bun run stack:setup                 # S3 bucket and SQS queues in LocalStack
bun run stack:down
bun run db:migrate
bun run seed:dev                    # demo project acme/portal, prints its key
bun run dev:api                     # API on API_PORT, default 8787
bun run dev:example                 # Vite host app with the widget
bun run synth                       # cdk synth, no AWS credentials needed
bun run env set NAME[=VALUE]        # manage .env.example and .env.local
```

`bun run check` leaves the Compose stack running. Integration tests use the real Compose Postgres and LocalStack, so start the stack before `bun run test`. Run widget tests from `modules/widget`, because its `bunfig.toml` preloads happy-dom. `bun run build` must run before the example app typecheck and e2e, because both read `modules/widget/dist`. `bun install` needs `GITHUB_TOKEN` with `read:packages` for the `@pressw-llc` packages.

Manage `.env.example` and `.env.local` only through `bun run env`, as the `env-files` skill describes. Never read or hand-edit them.

## Architecture

A Bun workspace with nine modules under `modules/*`. Packages are `@pw-support/<module>` and private, except `widget`, which is `@pressw-llc/support-react`.
- `contracts` holds the zod 3 schemas that every module shares.
- `db` owns the Postgres schema `support`, hand-written SQL migrations, and `appendEvent`. `migrations/pipeline/` holds the copied pipeline migrations. They run first.
- `db` also exports the query functions the API uses: `persistInboundRequest`, `persistInboundMessage`, `listCustomerRequests`, `getCustomerThread`, `getCustomerAttachment`, `markThreadRead`, `findProjectByKey`, `ensureProject`, and `hitRateLimit`. Every customer query takes a project and customer scope.
- `api` serves a Hono app on Bun. Routes in `app.ts` call `intake-service.ts`. `file-type.ts` and `message-checks.ts` hold the pure static checks. `middleware.ts` holds identity and rate limiting. `storage.ts` wraps S3.
- `widget` builds `@pressw-llc/support-react`: a Shadow DOM React widget plus a global browser bundle. It bundles `@pw-support/contracts` for the hash helper and keeps its own types.
- `triage` is a shell. Phase 2 adds `@pressw-llc/pipeline` and `@pressw-llc/managed-agents` at exact versions.
- `infra` defines the CDK stack in `us-east-1`.
- `admin`, `channels`, and `plugin` are shells until their phases land.
- `examples/host-app` is a stock Vite React app that embeds the widget. `e2e` runs Playwright against it and the API.

A module imports another module only through `@pw-support/contracts` or another module's bare package name. `scripts/lint-boundaries.ts` enforces this inside `bun run lint`.

`events` is an append-only table. A trigger rejects UPDATE, DELETE, and TRUNCATE. Append events through `appendEvent`.

Coverage runs through `bun test --coverage` with an 85 percent line and function floor set in `bunfig.toml`. Bun applies the floor per file. The widget has its own `bunfig.toml` with the same floor and ignores `modules/contracts`. The server entry, the example app, the e2e suite, and `scripts/` glue that no test loads are outside coverage.

The API persists the request, the first message, and `request.created` in one transaction before any static check or S3 upload runs. Keep that order.

This repository is public. Keep client names, client data, and real keys out of it. Use `acme` in fixtures.

## Delivery loop

Start work with `/delivery-loop:scope <branch>`. Use `/delivery-loop:activate` for planning or review with no worktree.

The delivery-loop skills own the methodology. Invoke them instead of re-deriving the process: `goal-prd`, `phased-plan`, `work`, `worktree-execution`, `adversarial-review-loop`, `live-validation`, `evidence-pr`, `debug-to-root-cause`.

Plans live under `docs/plans/<plan>/`. Each plan holds `PRD.md` and an `evidence/` directory.

Project settings live in `.delivery/config`. Template overrides live in `.delivery/templates/`. Both are committed. Session and run state is gitignored.
