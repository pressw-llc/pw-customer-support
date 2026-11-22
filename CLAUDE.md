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
bun run e2e                         # Playwright, starts the API, the admin app, the example app, and a worker with a Linear stub
bun run stack:up                    # Postgres, LocalStack, and the mock OIDC issuer, ports from .env.local
bun run stack:setup                 # S3 bucket and SQS queues in LocalStack
bun run stack:down
bun run db:migrate
bun run seed:dev                    # demo project acme/portal, prints its key
bun run dev:api                     # apps/server on API_PORT, default 8787
bun run dev:example                 # Vite host app with the widget
bun run dev:admin                   # Vite admin app, defaults to the local API and mock issuer
bun run synth                       # cdk synth with placeholder stage values, no AWS credentials needed
bun run release                     # widget package build and verification, dry run by default
bun run release --publish           # publish one tarball to npmjs and GitHub Packages, owner only
bun run deploy --dry-run            # config, build, images, synth, no AWS call
bun run deploy --stage production   # the one deploy entry, owner or the Deploy workflow only
bun run smoke                       # submit one request to an API and read back the Linear ticket
bun run demo                        # local demo with a printed walkthrough, bun run demo stop tears it down
bun run build:plugin                # bundled plugin directory and claude plugin validate
bun run validate:release            # two local Verdaccio registries, install, idempotent publish
bun run validate:deploy             # LocalStack deploy subset, LocalStack Lambda, and the production image
bun run dev:worker                  # triage worker, sweeper, dispatcher, adapter poller
bun run dev:linear-stub             # local Linear GraphQL stub
bun run agent:sync                  # publish the triage agent, writes a gitignored lock file
bun run seed:settings <teamId>      # set linear_team_id on the seed project
bun run validate:phase-2            # live Jev and Managed Agents validation, add --partial without an Anthropic key
bun run validate:phase-3            # live Jev validation of the reply loop, needs no Anthropic key
bun run validate:phase-4            # live admin validation: 401s, Secrets Manager, pg_dump scan, CC list
bun run validate:phase-5 --evidence-dir <dir>   # live laptop validation: MCP, real claude -p runs, watcher, needs TYPESAFE_API_KEY and a logged-in claude
bun run env set NAME[=VALUE]        # manage .env.example and .env.local
```

`bun run check` leaves the Compose stack running. Integration tests use the real Compose Postgres and LocalStack, so start the stack before `bun run test`. Run widget tests from `modules/widget`, because its `bunfig.toml` preloads happy-dom. `bun run build` must run before the example app typecheck and e2e, because both read `modules/widget/dist`. `bun install` needs `GITHUB_TOKEN` with `read:packages` for the `@pressw-llc` packages.

Manage `.env.example` and `.env.local` only through `bun run env`, as the `env-files` skill describes. Never read or hand-edit them.

## Architecture

A Bun workspace with nine modules under `modules/*` and the process entry under `apps/server`. Packages are `@pw-support/<module>` and private, except `widget`, which is `@pressw-llc/support-react`.
- `contracts` holds the zod 3 schemas that every module shares.
- `db` owns the Postgres schema `support`, hand-written SQL migrations, and `appendEvent`. `migrations/pipeline/` holds the copied pipeline migrations. They run first.
- `db` also exports the query functions the API uses: `persistInboundRequest`, `persistInboundMessage`, `listCustomerRequests`, `getCustomerThread`, `getCustomerAttachment`, `markThreadRead`, `findProjectByKey`, `ensureProject`, and `hitRateLimit`. Every customer query takes a project and customer scope.
- `api` serves a Hono app on Bun. Routes in `app.ts` call `intake-service.ts`. `file-type.ts` and `message-checks.ts` hold the pure static checks. `middleware.ts` holds identity and rate limiting. `storage.ts` wraps S3.
- `widget` builds `@pressw-llc/support-react`: a Shadow DOM React widget plus a global browser bundle. It bundles `@pw-support/contracts` for the hash helper and keeps its own types.
- `triage` runs the cloud side of a triage job: text extraction (linear scanners, run in a terminable Worker), the Jev injection filter, the agent session with its remote-definition guard, the worker (`handleWake`, `sweepOnce`), and the config. The claim protocol SQL lives in `db` (`triage-jobs.ts`). `claimJob`, `submitResult` (sends a wake when an invalid result reopens the job), and `renewLease` are exported for the laptop plugin. It pins `@pressw-llc/pipeline`, `@pressw-llc/managed-agents`, and `@anthropic-ai/sdk` at exact versions. `agents/support-triage` holds the agent definition. `corpus` holds the injection payloads.
- `db` also owns `triage_jobs`, `channel_delays`, `judgments`, `event_cursors`, `tickets`, and `ticket_deliveries`. `persistInboundRequest` opens the job in the request transaction.
- `infra` defines the CDK stacks in `us-east-1`: `PwSupport` (VPC, Aurora Serverless v2, attachments bucket, queues with DLQs and alarms, secrets policies, ECS cluster, migration task), `PwSupportApp` (API on Fargate behind an ALB, worker on Fargate, `linear-outbound` Lambda, admin site with a runtime config), and `PwSupportGithubOidc`. Stage values come from CDK context, `modules/infra/stage.<stage>.json`, or `SUPPORT_STAGE_CONFIG`. `bun run synth` uses placeholders. A deploy needs every value, and production requires `MCP_REQUIRED_GROUP`. `nag.test.ts` runs cdk-nag AwsSolutions with one-line suppressions in `nag-suppressions.ts`.
- `channels` holds the dispatcher with its redelivery, the Linear client, ticket builder, adapter, webhook intake, and the reply gate. The adapter contract lives in `contracts`. The Linear stub and fixtures live behind `@pw-support/channels/testing`, and the triage harness and file fixtures behind `@pw-support/triage/testing`.
- The reply loop: `POST /webhooks/linear` in `api` hands the raw body to the `channels` webhook intake, which verifies it and commits the comment and `comment.received`. The Linear adapter then applies the `@external` marker rule, scores the wording with Jev (hold below 2, flag from 2 to below 3, send from 3), and releases a customer message. `@confirm` in the thread releases a held reply that is older than the confirm and already warned. A confirm first fetches every live held comment of the thread from Linear and cancels the hold only when the body or author differs or the comment is gone. A failed fetch keeps the confirm pending. Editing or deleting a held comment cancels the hold and posts one `Reply hold cancelled.` notice in the thread. Changes order by the payload `updatedAt`: a change before its create goes to `support.comment_changes`, and a stale or superseded create refetches the current comment from Linear. A comment on an issue with no ticket stores ids only and fetches its body when the ticket appears. A comment with no human Linear user is always internal, and released staff text is converted to plain text. The same adapter posts widget follow-ups to the ticket.
- `db` also owns `inbound_comments`, `comment_changes`, `replies`, `webhook_deliveries`, and `message_deliveries`, in `replies.ts`. `comment-refresh.ts` applies a comment fetched from Linear. `redelivery.ts` holds the follow-up and inbound redelivery claims, orphan comment resolution, hold expiry, and the purge.
- `admin` is a Vite React app that renders all message text as plain text nodes and reads reply state from `support.replies`: Tailwind v4, shadcn/ui, TanStack Query, `oidc-client-ts`. Pure helpers in `src/lib` carry the unit tests. The React app under `src/app` and `src/components` is covered by Playwright. `plugin` is the Claude Code plugin and the `pw-support` CLI for laptop triage.
- `api` also validates staff tokens in `auth.ts` (`createTokenValidator`, exported for the MCP route) and serves `/admin/*` from `admin.ts` behind `requireStaff`. `testing/oidc.ts` and `testing/dump.ts` are exported as `@pw-support/api/testing`.
- Laptop triage: two endpoints in `api`. `POST /mcp` (`mcp.ts`) serves six state-only tools to the engineer's interactive session behind the staff token validator, `MCP_AUDIENCE`, and an optional `MCP_REQUIRED_GROUP`. No interactive tool returns customer text, and a contract test over the output schemas enforces it. `POST /mcp/laptop` (`mcp-laptop.ts`) serves `job_claim`, `job_renew`, `job_status`, and `job_submit_result`. No plugin config names it. It needs the engineer token plus a per-machine watcher credential that `pw-support watch run` generates, registers through `PUT /laptop/watcher`, and `pw-support logout` revokes. The server stores only a hash. A submit credential bound to one job and claim reaches `job_submit_result` only, for the stdio server, and the server stores its hash on the job. The credential raises the bar against an interactive session being steered to the endpoint. The remaining boundary is the operating system. Subscriptions live in `support.subscriptions` and match whole segments of the channel key. `job_claim` uses the atomic claim with kind `laptop`, runs `prepareAgentInput` before any content leaves the server, extends the lease, and answers `lease_lost` with no content when that fails. A flagged or unfiltered request completes as human triage and returns `nothingToDo`. `ADMIN_ALLOWED_EMAIL_DOMAINS` applies to `/admin` only. The per-engineer limit counts `tools/call` requests. The `plugin` watcher polls offers, claims one job, renews the lease, and runs `claude -p` with an environment allowlist, one tool `submit_result`, a verified init before the request, and a stream guard that kills the child on any other tool or hook. A timeout lets the lease lapse to the cloud. `apps/server` wires `createLaptopBackend` from `triage` into `api`, and `api` has no dependency on `triage`. `bun run lint` fails on a workspace dependency cycle. `validate:phase-5` makes real `claude -p` runs and the check never does.
- `db` also holds `admin.ts` (request list with the acknowledgement query, project, key, CC list, and integration writes with audit events) and the `integrations` table. An integration row holds a Secrets Manager reference, never a value.
- `channels` also holds `secrets.ts`: `createManagedSecrets`, `createSecretWriter`, and `createSecretsManagerClient`. The Linear client, the Jev client, and the admin save route use them.
- `infra` also defines `AdminSite` (private S3 bucket, CloudFront with OAC, the built app, and a `config.json` runtime config) and `SecretsAccess` (read and write managed policies scoped to the secrets prefix).
- `Dockerfile` builds the `api`, `worker`, `migrate`, and `lambda` targets from one production install. `apps/server` and the worker entry `pipelines/support-triage/fargate-entries/production.ts` run `runExtractionSelfTest` at start. `pipelines/linear-outbound/lambda-entries/production.ts` reads the database secret on cold start. `DATABASE_URL`, or `DB_HOST`, `DB_USER`, and `DB_PASSWORD`, set the database URL.
- `scripts/release.ts` and `scripts/release/lib.ts` build, verify, and publish `@pressw-llc/support-react`. `scripts/deploy.ts` bootstraps `scripts/deploy/main.ts`, which validates config, builds, deploys the foundation stack, runs the migration task, deploys the app stack, and runs `scripts/smoke.ts`. `.github/workflows/deploy.yml` is manual only and runs `bun run deploy --stage production`. `docs/runbook.md` holds the owner steps and operations. `docs/demo.md` describes `bun run demo`.
- `scripts/skills-audit.test.ts` checks that every module and app holds a skill, that the root holds the pipelines, managed-agents, and repository skills, that names are unique, and that skill paths exist.
- `pipelines/` at the root holds the `support-triage` Fargate pipeline and the `linear-outbound` Lambda pipeline. The Lambda step runs the one Linear adapter for tickets, follow-ups, and inbound comments. `bun run validate:pipelines` checks them and runs in the `lint` stage of `bun run check`. `tests/` holds cross-module criterion tests.
- `examples/host-app` is a stock Vite React app that embeds the widget. `e2e` runs Playwright against it and the API.

A module imports another module only through `@pw-support/contracts`, another module's bare package name, or a subpath that module declares in its `exports`. `scripts/lint-boundaries.ts` enforces this inside `bun run lint` and rejects `/src/` deep imports.

`events` is an append-only table. A trigger rejects UPDATE, DELETE, and TRUNCATE. Append events through `appendEvent`.

Coverage runs through `bun test --coverage` with an 85 percent line and function floor set in `bunfig.toml`. Bun applies the floor per file. The widget has its own `bunfig.toml` with the same floor and ignores `modules/contracts`. The `apps/server` entry, the plugin `cli.ts`, `run-watch.ts`, and `submit-main.ts` entries, the example app, the e2e suite, and `scripts/` glue that no test loads (`release.ts`, `deploy.ts`, `deploy/main.ts`, `smoke.ts`, `demo.ts`, `build-plugin.ts`, and the `validate/phase-*` scripts) are outside coverage. The admin React app (`modules/admin/src/app`, `components`, `main.tsx`) is excluded by `coveragePathIgnorePatterns` and covered by Playwright. The pure admin helpers in `modules/admin/src/lib` stay under the floor.

The API persists the request, the first message, and `request.created` in one transaction before any static check or S3 upload runs. Keep that order.

This repository is public. Keep client names, client data, and real keys out of it. Use `acme` in fixtures.

## Delivery loop

Start work with `/delivery-loop:scope <branch>`. Use `/delivery-loop:activate` for planning or review with no worktree.

The delivery-loop skills own the methodology. Invoke them instead of re-deriving the process: `goal-prd`, `phased-plan`, `work`, `worktree-execution`, `adversarial-review-loop`, `live-validation`, `evidence-pr`, `debug-to-root-cause`.

Plans live under `docs/plans/<plan>/`. Each plan holds `PRD.md` and an `evidence/` directory.

Project settings live in `.delivery/config`. Template overrides live in `.delivery/templates/`. Both are committed. Session and run state is gitignored.
