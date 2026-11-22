---

name: api-module
description: Work in the api module: the Hono HTTP server on Bun. Use when you add or change intake routes, static checks, attachment storage, rate limits, or later admin, webhook, and MCP routes.
---

# api module

## Ownership

`modules/api` owns the HTTP surface. It serves `GET /health`, the public intake routes under `/v1`, the staff routes under `/admin`, the Linear webhook, and the engineer MCP route at `/mcp`.

## Layout

| File                  | Role                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`              | `createApp(deps)`: CORS, body limit, identity, rate limit, thin routes, error handler                                                                                                                                                    |
| `intake-service.ts`   | Persist, then run checks, store files, record rejections, shape responses                                                                                                                                                                |
| `middleware.ts`       | `identify` resolves the key and upserts the customer. `rateLimit` counts per key and per user                                                                                                                                            |
| `file-type.ts`        | `detectFile` by magic bytes and `preflightAttachment` for count, size, and empty checks                                                                                                                                                  |
| `message-checks.ts`   | `checkMessage` strips well-formed markup in linear time and enforces the length caps                                                                                                                                                     |
| `storage.ts`          | `ObjectStorage` interface and the S3 implementation                                                                                                                                                                                      |
| `config.ts`           | `loadConfig(env)` with local defaults for the Compose stack                                                                                                                                                                              |
| `wake.ts`             | SQS client, queue lookup, and the wake sender that sends `DelaySeconds`. Triage reuses it                                                                                                                                                |
| `auth.ts`             | `createTokenValidator` and `parseBearer`. The MCP route reuses them                                                                                                                                                                      |
| `mcp.ts`              | `mcpRoutes` and `buildMcpServer`: the nine engineer tools over Streamable HTTP, stateless                                                                                                                                                |
| `admin.ts`            | `adminRoutes` and `requireStaff`: CORS, token check, body cap, mutation rate limit, `/admin/*` handlers                                                                                                                                  |
| `admin-presenters.ts` | Map db rows to the admin contracts                                                                                                                                                                                                       |
| `server.ts`           | Process entry. It is glue and no test loads it                                                                                                                                                                                           |
| `testing/`            | `fixtures.ts` builds magic-byte buffers. `harness.ts` builds an app against real Postgres and LocalStack. `oidc.ts` is a local issuer with signing helpers. `dump.ts` dumps the database. Both are exported as `@pw-support/api/testing` |

## Routes

`POST /v1/requests`, `GET /v1/requests`, `GET /v1/requests/:id`, `POST /v1/requests/:id/messages`, `POST /v1/requests/:id/read`, `GET /v1/attachments/:id`. Each needs `X-Support-Key` and `X-Support-User`.

`POST /webhooks/linear` takes the Linear `Comment` webhook. It sits outside `/v1`, skips key identity, and caps the body at `LINEAR_WEBHOOK_MAX_BYTES`. The route hands the raw bytes and two headers to the `LinearWebhookIntake` from `@pw-support/channels`. Without an intake it answers 503. `server.ts` builds one managed secrets provider and passes it to both the intake and the admin save route, so the webhook secret comes from Secrets Manager with the environment as fallback and the route fails closed with neither.

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
- Fail closed on `/admin/*`. A missing header, a bad token, a missing setting, or a JWKS outage returns 401. There is no bypass flag. Local login uses the mock issuer.
- Verify tokens with RS256 only. Accept `COGNITO_AUDIENCE` in `aud`, or in `client_id` when `aud` is absent.
- Never log or return an admin request body or an error message that could echo it. The admin error handler logs the error name and the path.
- Write an integration secret to Secrets Manager first, then store the reference in Postgres. Never store the value.
- `mcp.ts` serves `POST /mcp` for engineers. Build one `McpServer` per request with the identity from the token, so no tool argument can name an engineer. Fail closed with 401 and `WWW-Authenticate`. Rate limit per engineer subject. Never put message text in a tool that the description does not mark as content.
- Accept only the `MCP_AUDIENCE` client ids on `/mcp`. A refused claim returns `refused`. A refused result returns paths and short messages and never the value. A claim or result for another engineer's job answers like a stale claim.
- The laptop backend (`prepare`, `submit`) comes from `@pw-support/triage` through `createApp` deps, so the api module has no code path that reads an attachment for a laptop.
- Import other modules only through their package entrypoint.

## Tests

Integration tests use the real Compose Postgres and LocalStack. Title a test with the criterion it proves, for example `A2:`, `A4:`, `A17:`, or `D7:`. Use fake storage or fake checks only to inject faults.

## Commands

```bash
bun run dev:api
bun test modules/api
```
