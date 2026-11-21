---
name: pw-pipeline-lambda
description: Wire pipeline steps to AWS Lambda with `lambdaHandlerFor` - structured 1:1, N:M multi-step, and name-based registry forms; understand filesystem discovery limits for production bundles. Load when creating `lambda-entries/*.ts` or `steps/*/handler.ts`, when choosing one Lambda per step vs packed handlers, or when debugging cold-start module resolution failures.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-pipeline validate:*)
metadata:
  area: pw-pipeline
---

# Lambda wiring

Production Lambdas must bundle pipeline and step modules statically. Filesystem discovery works for `validate` and local `bun run` only.

## 1:1 structured form (recommended)

```typescript
// pipelines/greeter/lambda-entries/greet.ts
import { lambdaHandlerFor } from "@pressw-llc/pipeline";
import pipeline from "../pipeline.config.js";
import greet from "../steps/greet/index.js";

export const handler = lambdaHandlerFor({
  pipeline,
  stepName: "greet",
  step: greet,
});
```

CDK `NodejsFunction.entry` points here. esbuild walks every import; no runtime `import()`.

Use when the step needs its own memory, timeout, IAM scope, concurrency, or DLQ.

## N:M multi-step form

```typescript
import { lambdaHandlerFor } from "@pressw-llc/pipeline";
import pipeline from "../pipeline.config.js";
import enrichOwner from "../steps/enrich-owner/index.js";
import enrichTaxHistory from "../steps/enrich-tax-history/index.js";

export const handler = lambdaHandlerFor({
  pipeline,
  steps: {
    "enrich-owner": enrichOwner,
    "enrich-tax-history": enrichTaxHistory,
  },
});
```

- Keys must exist on `pipeline.graph`.
- Dispatch uses `record.body.stepName` (engine sets this on enqueue).
- Unknown `stepName` -> partial batch failure (SQS redelivery + alarm).

Use when steps share a resource profile (short JSON transforms, dev monolith).

## Name-based registry (dev or explicit registration)

```typescript
import { lambdaHandlerFor, registerPipeline, registerStep } from "@pressw-llc/pipeline";
import pipeline from "../pipeline.config.js";
import greet from "../steps/greet/index.js";

registerPipeline(pipeline);
registerStep("greeter", "greet", greet);

export const handler = lambdaHandlerFor("greeter", "greet");
```

Registration calls are side effects esbuild bundles cleanly. Unregistered name-based handlers fall back to filesystem discovery and **fail in deployed Lambdas**.

## Runtime configuration

Call once at cold-start (shared module imported by every entry):

```typescript
import { configureLambdaRuntime } from "@pressw-llc/pipeline";

configureLambdaRuntime({
  repoFactory: () => createRepo(process.env.DATABASE_URL!),
  sqs: { defaults: true }, // envQueueResolver + defaultSendMessage + envResumeQueueResolver
  agentSessionFactory,
  agentIdResolver,
});
```

`configureLambdaRuntime` and `configureFargateRuntime` share the same registry.

### SQS env vars (defaults: true)

```
PIPELINE_<PIPELINE>_<STEP>_QUEUE_URL
PIPELINE_<PIPELINE>_RESUME_QUEUE_URL
```

Non-alphanumerics in pipeline/step names become `_`. Missing vars throw at send time with the expected name.

## Discovery by environment

| Environment | Resolution |
| --- | --- |
| `pw-pipeline validate` | Filesystem (`walkPipelines` + `loadStep`) |
| Local `bun run` | Filesystem |
| Lambda (structured / registered) | Bundled imports or in-process Map |
| Lambda (unregistered names only) | **Fails at cold-start** |

## AWS endpoint note

Use `AWS_ENDPOINT_URL_SQS=http://localhost:4566` for LocalStack. Do **not** set global `AWS_ENDPOINT_URL` when the same process also calls Bedrock or other AWS APIs.

## References

- `pw-pipeline-define-step`, `pw-pipeline-fargate`, `pw-pipeline-local-dev`
- `examples/property-enrichment/pipelines/property-enrichment/handlers/`
