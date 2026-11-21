# pw-customer-support

A drop-in React support widget sends customer requests to a PressW backend. The backend triages each request into a Linear ticket and carries the reply thread back to the customer.

The product requirements and phased plan live in [docs/plans/customer-support-v1](docs/plans/customer-support-v1/PRD.md).

## Quick start

Install Bun 1.3, Docker, and set `GITHUB_TOKEN` to a token with `read:packages`. The `.npmrc` file uses it to install `@pressw-llc/*` packages.

```bash
bun install
bun run stack:up
bun run db:migrate
bun run check
```

The stack runs Postgres on `127.0.0.1:5447` and LocalStack on `127.0.0.1:4577`. Every script runs on built-in defaults against the local stack, so no env file is required.

## Environment

Put overrides in `.env.local`, which is gitignored.

| Variable                                     | Default                                             | Purpose                              |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------ |
| `SUPPORT_POSTGRES_PORT`                      | `5447`                                              | Host port for Postgres               |
| `SUPPORT_LOCALSTACK_PORT`                    | `4577`                                              | Host port for LocalStack             |
| `DATABASE_URL`                               | `postgres://support:support@127.0.0.1:5447/support` | Postgres connection string           |
| `AWS_REGION`                                 | `us-east-1`                                         | AWS region for the SDK clients       |
| `AWS_ENDPOINT_URL`                           | `http://127.0.0.1:4577`                             | AWS endpoint, LocalStack locally     |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test`                                              | Local credentials for LocalStack     |
| `ATTACHMENTS_BUCKET`                         | `pw-support-attachments`                            | S3 bucket for attachments            |
| `TRIAGE_WAKE_QUEUE`                          | `pw-support-triage-wake`                            | SQS queue that wakes triage          |
| `TRIAGE_WAKE_DLQ`                            | `pw-support-triage-wake-dlq`                        | Dead-letter queue for the wake queue |
| `API_PORT`                                   | `8787`                                              | Port for the Hono API server         |

## Commands

| Command                         | Action                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| `bun run check`                 | Run install, lint, typecheck, stack, test, and synth in order |
| `bun run check --skip-install`  | Run the same stages without the install                       |
| `bun run lint`                  | Run Biome and the module boundary check                       |
| `bun run typecheck`             | Run `tsc --noEmit` in every module                            |
| `bun test`                      | Run all tests                                                 |
| `bun test path/to/file.test.ts` | Run one test file                                             |
| `bun run stack:up`              | Start Postgres and LocalStack                                 |
| `bun run stack:down`            | Stop the stack and delete its volumes                         |
| `bun run db:migrate`            | Apply the SQL migrations to `DATABASE_URL`                    |
| `bun run synth`                 | Run `cdk synth` with no AWS credentials                       |

`bun run check` leaves the stack running. Run `bun run stack:down` to stop it.

## Modules

| Module              | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `modules/contracts` | Shared zod schemas and types              |
| `modules/db`        | Postgres schema, migrations, event stream |
| `modules/api`       | Hono HTTP server                          |
| `modules/widget`    | React widget, `@pressw-llc/support-react` |
| `modules/admin`     | Staff admin UI                            |
| `modules/triage`    | Triage jobs, agent, Linear outbound       |
| `modules/channels`  | Channel adapters                          |
| `modules/plugin`    | Claude Code plugin for laptop triage      |
| `modules/infra`     | AWS CDK stack                             |

A module imports another module only through `@pw-support/contracts` or the other module's package name. `bun run lint` rejects deep imports.

## Git hooks

`bun install` points `core.hooksPath` at `.githooks`. The `commit-msg` hook enforces conventional commits. The `pre-push` hook runs `bun run check --skip-install`.

## CI

`.github/workflows/ci.yml` runs `bun run check`. Set the `PACKAGES_READ_TOKEN` secret when the default token cannot read the `@pressw-llc` packages.
