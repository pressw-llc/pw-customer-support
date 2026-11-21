---
name: pw-pipeline-local-dev
description: Run pipeline examples end-to-end on a laptop with Docker Compose Postgres and LocalStack SQS - infra scripts, env conventions, live demos without in-process mocks, and example-runner helpers. Load when setting up local development for a pipeline consumer, when queue URLs are missing, or when reproducing parallel-join / Fargate behavior before deploy.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(docker:*)
metadata:
  area: pw-pipeline
---

# Local development

Examples in the monorepo run against **real** Postgres and SQS (LocalStack), not in-memory mocks. The same `executeStep`, `lambdaHandlerFor`, `fargateMain`, and join code paths execute locally as in production.

## Monorepo infra (pw-managed-pipelines root)

```bash
bun run infra:up      # postgres:16 :5435 + localstack :4566 (SQS)
bun run infra:setup   # migrations + create per-(pipeline,step) queues
cp .env.example .env  # DATABASE_URL, AWS_ENDPOINT_URL_SQS, etc.
```

## Env conventions

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres for pipeline state |
| `AWS_ENDPOINT_URL_SQS=http://localhost:4566` | LocalStack SQS only |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | LocalStack creds (test values) |

Do **not** set global `AWS_ENDPOINT_URL` if the same process also calls Bedrock / managed agents - it redirects every AWS client.

When mixing LocalStack SQS with profile-based Bedrock, construct `SQSClient` with explicit credentials and clear static keys before the Bedrock client (see root `CLAUDE.md`).

Load root `.env` before module-level credential providers:

```typescript
import { loadWorkspaceEnv } from "@pressw/example-runner";
loadWorkspaceEnv();
```

Bun does not auto-discover the monorepo root `.env` from a subdirectory.

## Example demos

```bash
bun run --filter @pressw/greeter-pipeline-example demo:fanout
bun run --filter @pressw/greeter-pipeline-example demo:fargate
bun run --filter @pressw/property-enrichment-example demo
bun run --filter @pressw/property-summary-example demo   # live Anthropic
```

Shared helpers live in `@pressw/example-runner` (`lambdaPoller`, `waitForRunTerminal`, `envQueueResolverFor`, `resolveQueueUrls`).

## Validate without infra

```bash
bunx pw-pipeline validate
```

Filesystem discovery works without Docker when you only need graph / file checks.

## New pipeline in a consumer repo

1. Copy env pattern from monorepo `.env.example`.
2. Register queues in your infra layer (or reuse `infra/setup.ts` pattern).
3. `bunx pw-pipeline skills install` for authoring guidance.
4. Run `validate` in CI.

## References

- Root `CLAUDE.md` environment conventions
- `pw-pipeline-parallel` (fanout demo exercises join SQL)
- `examples/_runner` package
