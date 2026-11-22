---

name: pw-support-repo
description: Orient in the PressW Customer Support repository. Use when you start work here, add a module, run the local stack, the check script, the demo, a release, or a deploy, or look for the plans and the runbook.
---

# pw-support-repo

## Module map

| Module | Package | Owns |
| --- | --- | --- |
| `contracts` | `@pw-support/contracts` | Shared zod schemas: channel keys, events, messages, identity hash, attachment limits, triage result, resource names |
| `db` | `@pw-support/db` | Postgres schema `support`, SQL migrations, migration runner, `appendEvent`, the query functions |
| `api` | `@pw-support/api` | Hono server on Bun: intake, admin, Linear webhook, MCP routes |
| `widget` | `@pressw-llc/support-react` | React support widget, published to npmjs and GitHub Packages |
| `admin` | `@pw-support/admin` | Staff admin UI, a Vite app |
| `triage` | `@pw-support/triage` | Claim protocol, Jev filter, sandboxed agent, text extraction, worker |
| `channels` | `@pw-support/channels` | Channel adapters, starting with Linear, and the dispatcher |
| `plugin` | `@pw-support/plugin` | Claude Code plugin and `pw-support` CLI for laptop triage |
| `infra` | `@pw-support/infra` | AWS CDK stacks in `us-east-1`: foundation, app, and GitHub OIDC |

`apps/server` is the process entry that wires the modules. `pipelines/` holds the `support-triage` Fargate pipeline and the `linear-outbound` Lambda pipeline.

Each module holds its own skill at `modules/<module>/.claude/skills/<module>-module/SKILL.md`. `apps/server` holds `server-app`.

## Boundary rule

A module imports another module only through `@pw-support/contracts` or the other module's bare package name. A deep import into another module's source folder fails `bun run lint`. The check lives in `scripts/lint-boundaries.ts`.

## Commands

Use `bun` for every command.

```bash
bun install
bun run check                  # install, lint, build, typecheck, stack, test, e2e, synth
bun run check --skip-install
bun run stack:up               # Postgres on 5447, LocalStack on 4577, mock issuer on 4599
bun run stack:down
bun run demo                   # local stack, API, worker, Linear stub, admin, host app
bun run release                # dry run of the widget release
bun run deploy --dry-run       # config, build, images, and synth with no AWS call
bun run validate:release       # two local registries, install, idempotent publish
bun run validate:deploy        # LocalStack deploy subset and the production image
bun run build:plugin           # bundled plugin directory and claude plugin validate
```

`bun run check` leaves the stack running.

## Release and deploy

`bun run release --publish` and `bun run deploy --stage production` need owner action first. `docs/runbook.md` lists the prerequisites in order. No agent publishes a package or deploys without an owner instruction.

## Vendored skills

The `pw-pipeline-*` and `pw-agents-*` skills are upstream copies. Do not edit them beyond the two local patches below.

They describe the pipelines repository's own ports and compose file. This repository uses Postgres on 5447 and LocalStack on 4577 through the root `docker-compose.yml`.

This repository carries two local patches. `.claude/skills/pw-agents-multiagent/SKILL.md` resolves the specialist lock file paths from the module directory instead of the working directory. `.claude/skills/pw-agents-sessions/SKILL.md` skips child-thread idle events in the custom session loop.

A `skills install --force` refresh overwrites both patches until upstream ships the fix. Re-apply or check them after each refresh.

```bash
bunx pw-pipeline skills install --force
bunx pw-managed-agents skills install --force
```

## Plans

Plans live in `docs/plans/customer-support-v1/`. `docs/plans/customer-support-v1/PRD.md` holds the locked decisions and the acceptance criteria. `docs/plans/customer-support-v1/PLAN.md` holds the phases. Start work with `/delivery-loop:scope <branch>`.

## Rules

- Keep client names, client data, and real keys out of this public repository. Use `acme` in fixtures.
- Never commit `.env.local`.
- Manage `.env.example` and `.env.local` through `bun run env`. The `env-files` skill describes it.
- Use the pipelines and managed-agents skills in this directory when you touch `triage`.
