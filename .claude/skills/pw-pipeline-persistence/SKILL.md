---
name: pw-pipeline-persistence
description: Work with the pipeline Postgres schema - task_run, pipeline_run, pipeline_step_run, activity_log; apply migrations; use createClient and Repo; avoid driver and SQL pitfalls in parallel-join queries. Load when adding persistence to a consumer app, when running migrations, or when debugging duplicate step rows / join CAS failures.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(psql:*)
metadata:
  area: pw-pipeline
---

# Persistence

Durable state lives in Postgres via Drizzle (`src/persistence/schema.ts`).

## Tables

| Table | Role |
| --- | --- |
| `task_run` | User-visible unit of work (optional parent for nested pipelines). |
| `pipeline_run` | One execution of one pipeline definition. |
| `pipeline_step_run` | Per-step state; parallel parent row is the join coordinator. |
| `activity_log` | Append-only rows from `ctx.activityLog` and the runner. |

## Migrations

Shipped under `src/persistence/migrations/`:

```bash
psql "$DATABASE_URL" -f node_modules/@pressw-llc/pipeline/src/persistence/migrations/0000_initial.sql
psql "$DATABASE_URL" -f node_modules/@pressw-llc/pipeline/src/persistence/migrations/0001_activity_log.sql
```

Monorepo local infra applies these via `bun run infra:setup` at the repo root.

## Client factory

```typescript
import { createClient } from "@pressw-llc/pipeline/persistence";

const db = createClient(process.env.DATABASE_URL!);
```

Wire `repoFactory` in `configureLambdaRuntime` / `configureFargateRuntime` so handlers persist step transitions.

## Repo pitfalls (production-only)

Unit tests may not hit a real database. Three issues that only appear live:

1. **Driver result shape** - normalize `db.execute` results:
   ```typescript
   const rows = Array.isArray(r) ? r : (r as { rows?: T[] }).rows ?? [];
   ```
2. **Array parameters** - do not pass JS arrays to `sql\`ANY(${siblings})\``. Use a `::text[]` literal with escaped elements.
3. **Parallel join counts** - always `count(distinct step_name)` in CAS predicates.

See `pw-pipeline-parallel` for join semantics.

## activity_log

`ctx.activityLog({ ... })` is fire-and-forget. Errors are logged, never thrown. No-op when no repo is configured (typical in isolated unit tests of handlers).

## References

- `pw-pipeline-parallel`, `pw-pipeline-local-dev`
- `packages/pw-pipeline/CLAUDE.md` persistence section
