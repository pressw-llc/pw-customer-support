# pw-customer-support

A drop-in React support widget sends customer requests to a PressW backend. The backend triages each request into a Linear ticket and carries the reply thread back to the customer.

The product requirements and phased plan live in [docs/plans/customer-support-v1](docs/plans/customer-support-v1/PRD.md).

## Quick start

Install Bun 1.3, Docker, and set `GITHUB_TOKEN` to a token with `read:packages`. The `.npmrc` file uses it to install `@pressw-llc/*` packages.

```bash
bun install
bun run stack:up
bun run stack:setup
bun run db:migrate
bun run check
```

The stack runs Postgres on `127.0.0.1:5447` and LocalStack on `127.0.0.1:4577`. Set `SUPPORT_POSTGRES_PORT` or `SUPPORT_LOCALSTACK_PORT` to change them. Copy `.env.example` to `.env.local` to override any other variable. Every script works with the defaults when `.env.local` is absent.

## Run the widget locally

Start the stack, seed a demo project, then start the API and the example host app in two terminals.

```bash
bun run stack:up && bun run stack:setup
bun run seed:dev
bun run dev:api
```

`seed:dev` prints the project key for `acme/portal`. It is idempotent and prints the same key on every run. Pass the key to the example app and start it.

```bash
bun run build
VITE_SUPPORT_PROJECT_KEY=<printed key> \
VITE_SUPPORT_USER_EMAIL=ada@acme.test \
VITE_SUPPORT_API_URL=http://127.0.0.1:8787 \
bun run dev:example
```

Open the printed Vite URL. The host app uses one import and two props:

```tsx
import { SupportWidget } from "@pressw-llc/support-react";

<SupportWidget projectKey="pk_..." userEmail="ada@acme.test" />;
```

Script-tag use loads `dist/support-widget.global.js` and calls `window.PressWSupport.mount(element, { projectKey, userEmail, apiUrl })`.

## Commands

| Command                         | Action                                                                    |
| ------------------------------- | ------------------------------------------------------------------------- |
| `bun run check`                 | Run install, lint, build, typecheck, stack, test, e2e, and synth in order |
| `bun run check --skip-install`  | Run the same stages without the install                                   |
| `bun run lint`                  | Run Biome and the module boundary check                                   |
| `bun run build`                 | Build the widget into `modules/widget/dist`                               |
| `bun run typecheck`             | Run `tsc --noEmit` in every module, the example app, and e2e              |
| `bun run test`                  | Run root tests, then the widget tests under happy-dom                     |
| `bun test path/to/file.test.ts` | Run one root test file                                                    |
| `bun run e2e`                   | Run the Playwright suite. It starts the API and the example app           |
| `bun run stack:up`              | Start Postgres and LocalStack                                             |
| `bun run stack:setup`           | Create the S3 bucket and SQS queues in LocalStack                         |
| `bun run stack:down`            | Stop the stack and delete its volumes                                     |
| `bun run db:migrate`            | Apply the SQL migrations to `DATABASE_URL`                                |
| `bun run seed:dev`              | Create the demo project and print its project key                         |
| `bun run dev:api`               | Migrate, set up the stack, and start the API on `API_PORT`                |
| `bun run dev:example`           | Start the example host app with Vite                                      |
| `bun run synth`                 | Run `cdk synth` with no AWS credentials                                   |

`bun run check` leaves the stack running. Run `bun run stack:down` to stop it. The e2e stage installs Chromium when it is missing. Screenshots land in `e2e/artifacts`.

## Intake API

Every `/v1` route needs the header `X-Support-Key` with the project key and `X-Support-User` with the lowercase hex `SHA-256(email + key)`. CORS allows any origin. An unknown or revoked key returns 401.

| Route                            | Action                                                |
| -------------------------------- | ----------------------------------------------------- |
| `POST /v1/requests`              | Multipart `text` and up to 10 `files`. Returns 201    |
| `GET /v1/requests`               | List the customer's requests with previews and unread |
| `GET /v1/requests/:id`           | Read the thread. Internal messages never appear       |
| `POST /v1/requests/:id/messages` | Send a follow-up with the same checks                 |
| `POST /v1/requests/:id/read`     | Mark the thread read                                  |
| `GET /v1/attachments/:id`        | Stream a stored attachment                            |
| `GET /health`                    | Return `{ "status": "ok" }`                           |

The API commits the request, the first message, and a `request.created` event before it runs any static check. A message with markup or over 10,000 characters stays stored and gets `body_flagged`. An attachment is accepted by magic bytes, not by name. Each rejected file returns a reason: `too_many_files`, `too_large`, `empty`, `executable`, `video`, `type_not_allowed`, or `storage_failed`. Rate limits use fixed windows in Postgres per project key and per hashed ID, and return 429 with `Retry-After`.

## Environment variables

Every variable has a default for the local stack.

| Variable                    | Default                      | Purpose                                        |
| --------------------------- | ---------------------------- | ---------------------------------------------- |
| `DATABASE_URL`              | local Postgres URL           | Postgres connection                            |
| `SUPPORT_POSTGRES_PORT`     | `5447`                       | Compose Postgres port                          |
| `SUPPORT_LOCALSTACK_PORT`   | `4577`                       | Compose LocalStack port                        |
| `API_PORT`                  | `8787`                       | API listen port                                |
| `ATTACHMENTS_BUCKET`        | `pw-support-attachments`     | S3 bucket for attachments                      |
| `AWS_ENDPOINT_URL`          | LocalStack unless production | S3 endpoint                                    |
| `AWS_REGION`                | `us-east-1`                  | S3 region                                      |
| `AWS_ACCESS_KEY_ID`         | `test` unless production     | S3 credentials                                 |
| `AWS_SECRET_ACCESS_KEY`     | `test` unless production     | S3 credentials                                 |
| `NODE_ENV`                  | unset                        | `production` turns off the LocalStack defaults |
| `RATE_LIMIT_WINDOW_SECONDS` | `60`                         | Rate limit window length                       |
| `RATE_LIMIT_PER_KEY`        | `600`                        | Requests per window for one project key        |
| `RATE_LIMIT_PER_USER`       | `120`                        | Requests per window for one hashed ID          |
| `MAX_REQUEST_BYTES`         | 251 MiB                      | Request body cap before a 413                  |
| `SEED_CLIENT_SLUG`          | `acme`                       | `seed:dev` client slug                         |
| `SEED_PROJECT_SLUG`         | `portal`                     | `seed:dev` project slug                        |
| `SEED_PROJECT_KEY`          | random                       | `seed:dev` key for a new project               |
| `SUPPORT_API_URL`           | `http://localhost:8787`      | Widget build-time default API URL              |
| `VITE_SUPPORT_PROJECT_KEY`  | none                         | Example app project key                        |
| `VITE_SUPPORT_USER_EMAIL`   | none                         | Example app signed-in email                    |
| `VITE_SUPPORT_API_URL`      | widget default               | Example app API URL                            |

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

`examples/host-app` is a fresh Vite React app that embeds the widget. `e2e` holds the Playwright suite.

A module imports another module only through `@pw-support/contracts` or the other module's package name. `bun run lint` rejects deep imports.

## Git hooks

`bun install` points `core.hooksPath` at `.githooks`. The `commit-msg` hook enforces conventional commits. The `pre-push` hook runs `bun run check --skip-install`.

## CI

`.github/workflows/ci.yml` runs `bun run check`. Set the `PACKAGES_READ_TOKEN` secret when the default token cannot read the `@pressw-llc` packages.
