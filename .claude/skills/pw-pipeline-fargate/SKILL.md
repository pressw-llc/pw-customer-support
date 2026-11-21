---
name: pw-pipeline-fargate
description: Run long-running pipeline steps on Fargate with `fargateMain` and `configureFargateRuntime` - SQS long-poll, visibility heartbeat, graceful shutdown, mock SQS adapter, and `createCredentialRefresher` for multi-hour agent sessions. Load when deploying managed-agent steps, when a step exceeds Lambda limits, or when debugging stuck / redelivered Fargate messages.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-pipeline validate:*)
metadata:
  area: pw-pipeline
---

# Fargate wiring

Managed-agent steps and other long work use `runtime: "fargate"` in the graph and a container entry that calls `fargateMain`.

## Entry module

```typescript
// pipelines/property-enrichment/fargate-entries/contact-resolver.ts
import { configureFargateRuntime, fargateMain } from "@pressw-llc/pipeline";
import pipeline from "../pipeline.config.js";
import contactResolver from "../steps/contact-resolver/index.js";
import { repoFactory } from "../shared/repo.js";

configureFargateRuntime({
  repoFactory,
  sqs: { defaults: true },
  agentSessionFactory: /* runOneShot wrapper */,
  agentIdResolver: /* lock-file reader */,
});

await fargateMain({
  pipeline,
  stepName: "contact-resolver",
  step: contactResolver,
  queueUrl: process.env.PW_FARGATE_QUEUE_URL!,
  visibilityTimeoutSec: 900,
});
```

## Lifecycle

1. **Receive** - long-poll with `WaitTimeSeconds: 20`, one message at a time.
2. **Heartbeat** - `ChangeMessageVisibility` on an interval (default ~half the visibility window, max 60s) while the step runs.
3. **Success** - `DeleteMessage`. **Failure** - leave message; SQS redelivers after visibility expires.
4. **Shutdown** - SIGTERM/SIGINT finishes the in-flight message, then exits (required for ECS draining).

Inject `args.sqs` (`FargateSqsAdapter`) to test without real SQS (`tests/unit/fargate-main.test.ts`).

## Credential refresh

SigV4 / API-key sources may go stale on containers running longer than a few hours. Wrap mint logic:

```typescript
import { createCredentialRefresher, configureFargateRuntime } from "@pressw-llc/pipeline";
import { createClient, runOneShot } from "@pressw-llc/managed-agents";

const refresher = createCredentialRefresher<string>({
  async mint() {
    return loadApiKeyFromSecretsManager();
  },
  refreshEveryMs: 5 * 60 * 60_000,
  onRefreshFailed(err) {
    console.error("credential refresh failed:", err);
  },
});

configureFargateRuntime({
  async agentSessionFactory(args) {
    const apiKey = await refresher.get();
    const client = await createClient({ mode: "api-key", apiKey });
    const result = await runOneShot({ agent: args.agentId, prompt: /* ... */, client });
    return { textOutput: result.textOutput, toolCalls: result.toolCalls, sessionId: result.sessionId };
  },
});
```

- Concurrent `get()` calls coalesce to one `mint()`.
- Refresh failure with cached value: soft fail via `onRefreshFailed`.
- First mint failure: `get()` rejects.
- After 401: `refresher.invalidate()`.

## Graph rule

Validator check 5: `defineAgentStep({ agent: { kind: "managed" } })` requires `runtime: "fargate"`.

## References

- `pw-pipeline-agent-steps`, `pw-pipeline-lambda`
- `examples/greeter-pipeline` Fargate demo (`demo:fargate`)
