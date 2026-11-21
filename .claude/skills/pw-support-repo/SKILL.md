---
name: pw-support-repo
description: Orient in the PressW Customer Support repository. Use when you start work here, add a module, run the local stack or the check script, or look for the plans.
---

# pw-support-repo

## Module map

| Module | Package | Owns |
| --- | --- | --- |
| `contracts` | `@pw-support/contracts` | Shared zod schemas: channel keys, events, messages, identity hash, attachment limits, triage result |
| `db` | `@pw-support/db` | Postgres schema `support`, SQL migrations, migration runner, `appendEvent` |
| `api` | `@pw-support/api` | Hono server on Bun |
| `widget` | `@pressw-llc/support-react` | React support widget |
| `admin` | `@pw-support/admin` | Staff admin UI |
| `triage` | `@pw-support/triage` | Claim protocol, Jev filter, sandboxed agent, Linear outbound |
| `channels` | `@pw-support/channels` | Channel adapters, starting with Linear |
| `plugin` | `@pw-support/plugin` | Claude Code plugin for laptop triage |
| `infra` | `@pw-support/infra` | AWS CDK stack in `us-east-1` |

Each module holds its own skill at `modules/<module>/.claude/skills/<module>-module/SKILL.md`.

## Boundary rule

A module imports another module only through `@pw-support/contracts` or the other module's bare package name. A deep path such as `@pw-support/db/src/x` or a relative path such as `../../db/src/x` fails `bun run lint`. The check lives in `scripts/lint-boundaries.ts`.

## Commands

Use `bun` for every command.

```bash
bun install
bun run stack:up      # Postgres on 5447, LocalStack on 4577
bun run db:migrate
bun run check         # install, lint, typecheck, stack, test, synth
bun run check --skip-install
bun run stack:down
```

`bun run check` leaves the stack running.

## Plans

Plans live in `docs/plans/customer-support-v1/`. `PRD.md` holds the locked decisions and the acceptance criteria. `PLAN.md` holds the phases. Start work with `/delivery-loop:scope <branch>`.

## Rules

- Keep client names, client data, and real keys out of this public repository. Use `acme` in fixtures.
- Never commit `.env.local`.
- Use the pipelines and managed-agents skills in this directory when you touch `triage`.
