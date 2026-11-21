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
- Keep the drizzle schema in `src/schema.ts` in step with the SQL.
- Test against the Compose Postgres. Do not mock the database.

## Commands

```bash
bun run stack:up
bun run db:migrate
bun test modules/db
```
