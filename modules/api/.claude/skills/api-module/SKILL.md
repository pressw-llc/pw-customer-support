---

name: api-module
description: Work in the api module: the Hono HTTP server on Bun. Use when you add or change intake routes, static checks, attachment storage, rate limits, or later admin, webhook, and MCP routes.
---

# api module

## Ownership

`modules/api` owns the HTTP surface. It serves `GET /health` and the public intake routes under `/v1`. Later phases add the Linear webhook, admin routes, and the MCP route.

## Layout

| File                | Role                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `app.ts`            | `createApp(deps)`: CORS, body limit, identity, rate limit, thin routes, error handler                                   |
| `intake-service.ts` | Persist, then run checks, store files, record rejections, shape responses                                               |
| `middleware.ts`     | `identify` resolves the key and upserts the customer. `rateLimit` counts per key and per user                           |
| `file-type.ts`      | `detectFile` by magic bytes and `preflightAttachment` for count, size, and empty checks                                 |
| `message-checks.ts` | `checkMessage` strips markup in linear time and enforces the length caps. The stripper lives in `@pw-support/contracts` |
| `storage.ts`        | `ObjectStorage` interface and the S3 implementation                                                                     |
| `config.ts`         | `loadConfig(env)` with local defaults for the Compose stack                                                             |
| `wake.ts`           | SQS client, queue lookup, and the wake sender that sends `DelaySeconds`. Triage reuses it                               |
| `server.ts`         | Process entry. It is glue and no test loads it                                                                          |
| `testing/`          | `fixtures.ts` builds magic-byte buffers. `harness.ts` builds an app against real Postgres and LocalStack                |

## Routes

`POST /v1/requests`, `GET /v1/requests`, `GET /v1/requests/:id`, `POST /v1/requests/:id/messages`, `POST /v1/requests/:id/read`, `GET /v1/attachments/:id`. Each needs `X-Support-Key` and `X-Support-User`.

`POST /webhooks/linear` takes the Linear `Comment` webhook. It sits outside `/v1`, skips key identity, and caps the body at `LINEAR_WEBHOOK_MAX_BYTES`. The route hands the raw bytes and two headers to the `LinearWebhookIntake` from `@pw-support/channels`. Without an intake it answers 503.

## Rules

- Never parse the webhook body before the signature check. Pass raw bytes to the intake.
- Build the app in `createApp` so tests call `app.request` without a socket.
- Persist the request, the message, and the event in one transaction before any processing. Never reorder this.
- The same transaction opens the triage job. After the checks and uploads finish, call `markIntakeComplete`, then send the wake message. Call `markMessageIntakeComplete` for every message when its checks and uploads end. The follow-up sync waits for it. A failed wake send never fails the request. The worker sweeper recovers the job.
- Scope every customer query by project and customer. Use the repository functions in `@pw-support/db`.
- Append state changes through `appendEvent`. Add new event types to `@pw-support/contracts` first.
- Cap inbound text at `MAX_STORED_MESSAGE_CHARS` before any strip work. Persist the truncated text, flag `too_long`, and answer `truncated: true`. Return 413 for a text field above `MAX_TEXT_FIELD_BYTES`, a transport limit applied before persistence.
- Never add a regex with unbounded repetition over user text. Use a linear scanner.
- Decide attachment type by magic bytes, never by filename or declared type.
- Never store a rejected file in S3. Record the rejection and append `attachment.rejected`.
- Return 404 for a request or attachment outside the caller's scope. Never return another scope's rows.
- Import other modules only through their package entrypoint.

## Tests

Integration tests use the real Compose Postgres and LocalStack. Title a test with the criterion it proves, for example `A2:`, `A4:`, `A17:`, or `D7:`. Use fake storage or fake checks only to inject faults.

## Commands

```bash
bun run dev:api
bun test modules/api
```
