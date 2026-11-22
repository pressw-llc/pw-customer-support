---

name: server-app
description: Work in the server app: the process entry that wires the API, triage, and channels modules, and the production Dockerfile roles. Use when you change startup, configuration wiring, the container image, or the deploy entry points.
---

# server app

## Ownership

`apps/server` owns the API process entry in `apps/server/src/server.ts`. It builds the database client, the token validators, the managed secrets provider, object storage, the wake sender, the Linear webhook intake, and the laptop backend, then calls `createApp` from `@pw-support/api` and serves it on Bun. It holds no routes.

The worker and the Lambda step have their own entries under `pipelines/`:

| Entry                                                    | Role                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/server/src/server.ts`                              | The API service                                                                  |
| `pipelines/support-triage/fargate-entries/production.ts` | Triage worker, sweeper, and dispatcher. It does not poll the adapter queue       |
| `pipelines/support-triage/fargate-entries/main.ts`       | The same worker plus an in-process adapter poller for local runs                 |
| `pipelines/linear-outbound/lambda-entries/production.ts` | The `linear-outbound` Lambda handler. It reads the database secret on cold start |
| `scripts/db-migrate.ts`                                  | The one-off migration, run as an ECS task                                        |

## Rules

- Run `runExtractionSelfTest` before the server listens and before the worker starts. A failure stops the process and the container start.
- Read every setting from the environment through the module config loaders. Add no setting that is local only to this app.
- Log warnings from `productionWarnings` at start. Never log a secret or a token.
- Keep `Dockerfile` targets `api`, `worker`, `migrate`, and `lambda` in step with these entries. Run as the `bun` user. Install production dependencies only.
- Build the image with `docker build --secret id=github_token,env=GITHUB_TOKEN --target api -t pw-support-api .`. The token never enters a layer.
- Keep `.dockerignore` excluding source that the image does not need. The install layer still needs every workspace `package.json`.
- Run the deployed image only through `bun run deploy`. `bun run validate:deploy` runs the image against the Compose stack.

## Commands

```bash
bun run dev:api
bun run dev:worker
bun run validate:deploy
```
