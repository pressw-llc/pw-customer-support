---

name: db-module
description: Work in the db module: Postgres schema, hand-written migrations, the migration runner, and the append-only event stream. Use when you add a table, write a migration, or append events.
---

# db module

## Ownership

`modules/db` owns the Postgres schema `support`, the drizzle table definitions, the SQL migrations, the migration runner, and `appendEvent`.

## Rules

- Write migrations by hand in `migrations/NNNN_name.sql`. Make each one idempotent.
- Pipeline migrations live in `migrations/pipeline/` and run first. Do not add a client literal to them.
- Use UUID primary keys. Keep every table in the `support` schema.
- Append events only through `appendEvent`. A trigger rejects UPDATE, DELETE, and TRUNCATE on `support.events`.
- `appendEvent` takes a transaction-scoped advisory lock before the insert, and wraps a bare db handle in a transaction. Event appends serialize, so `seq` follows commit order and is a safe cursor for readers that poll `seq > cursor`.
- Keep a transaction that appends an event short. The lock holds until commit.
- Keep the drizzle schema in `src/schema.ts` in step with the SQL.
- Open the triage job in the request transaction. `persistInboundRequest` writes the request, the first message, `request.created`, the `triage_jobs` row, and `triage.job.opened` together.
- Decide a job claim with one `UPDATE ... RETURNING` in `claimTriageJob`. A `FOR UPDATE` CTE re-checks the eligibility predicate after a lock wait, so parallel claims yield one winner.
- Pass `now` and `timing` to every job function. Tests control the clock without sleeping.
- Complete a job through `submitTriageResult` or `submitHumanTriage`. Both validate against the contracts schema. An invalid result reopens the job for the cloud.
- A job is claimable only after `markIntakeComplete` or the intake grace period. This stops a worker from reading attachments the API has not stored yet.
- `support.judgments` keeps every raw Jev judgment for V2. `support.tickets` holds one row per request. `support.event_cursors` holds one cursor per adapter.
- Test against the Compose Postgres. Do not mock the database.

## Commands

```bash
bun run stack:up
bun run db:migrate
bun test modules/db
```
