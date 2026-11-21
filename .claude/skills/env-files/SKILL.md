---
name: env-files
description: Add, change, or remove an environment variable, store a key or secret for local development, seed .env.local from .env.example, or diagnose a missing variable. Use whenever a task touches .env.example or .env.local.
---

# env-files

## Rule

Never read, print, or hand-edit `.env.local` or `.env.example`. Always go through `bun run env`. The script never prints a value.

Add every new variable with `set` in the same change that introduces it. Add a row for it to the README Environment table in that change.

## Commands

Add a non-secret default. The value lands in both files.

```bash
bun run env set API_PORT=8787 --comment "Hono API server port"
```

Add a secret. The example gets a blank. Pipe the value so it never appears in a command line or output.

```bash
some-command | bun run env set LINEAR_API_KEY --secret --stdin
```

Add a blank key to both files. An existing value stays.

```bash
bun run env set COGNITO_ISSUER
```

Write only one file.

```bash
bun run env set NEW_FLAG=1 --example-only
bun run env set LOCAL_TWEAK=1 --local-only
```

Create `.env.local` from the template, or add keys that the template gained. It never overwrites a local value.

```bash
bun run env sync
```

Remove a key and its comment.

```bash
bun run env unset OLD_KEY
```

Show every key from either file with `example: default|blank|missing` and `local: set|blank|missing`.

```bash
bun run env list
```

Fail when `.env.local` lacks a key from `.env.example`.

```bash
bun run env check
```

## Notes

- The script rejects unknown flags and extra arguments before it reads stdin or writes a file.
- Values with `$` are written in single quotes with `\$` escapes so Bun reads them literally.
- `DATABASE_URL` and `AWS_ENDPOINT_URL` are derived from the port variables. Set them only to override.
- Keys match `^[A-Z][A-Z0-9_]*$`.
- Updating a key replaces its line in place and keeps other lines, comments, and order.
- `.env.local` has mode 0600 and stays gitignored.
- Scripts run on built-in defaults without `.env.local`.
