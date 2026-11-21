---
name: pw-pipeline-define-step
description: Author a pipeline step with `defineStep` - Zod input/output schemas, the handler signature, and `StepContext` surfaces (`priorOutputs`, `activityLog`, `enqueueResume`, `fail`). Load when creating `steps/<name>/index.ts` and `schema.ts`, when wiring handler logic, or when deciding what belongs in step I/O vs pipeline graph config.
allowed-tools: Read, Write, Edit, Bash(bunx pw-pipeline validate:*)
metadata:
  area: pw-pipeline
---

# Define a step

Each step lives under `pipelines/<pipeline>/steps/<step-name>/` and default-exports `defineStep({ input, output, handler })`.

## Step module

```typescript
// steps/greet/index.ts
import { defineStep } from "@pressw-llc/pipeline/define";
import { GreetInput, GreetOutput } from "./schema.js";

export default defineStep({
  input: GreetInput,
  output: GreetOutput,
  async handler(input, ctx) {
    return { message: `Hello, ${input.name}` };
  },
});
```

```typescript
// steps/greet/schema.ts
import { z } from "zod";

export const GreetInput = z.object({ name: z.string() });
export const GreetOutput = z.object({ message: z.string() });
```

The engine validates I/O at the boundary using these Zod schemas.

## StepContext surfaces

| Surface | Status |
| --- | --- |
| `ctx.runId`, `ctx.stepName`, `ctx.pipelineName` | Available |
| `ctx.priorOutputs` | Populated on the step after a parallel join (`pw-pipeline-parallel`) |
| `ctx.activityLog(entry)` | Fire-and-forget append to `activity_log`; no-op without repo |
| `ctx.enqueueResume(toStep, payload)` | Producer side when `resumeQueueResolver` is configured |
| `ctx.fail({ message, field? })` | Marks step failed with structured error |
| `ctx.mcp` | Stub - throws `NotImplementedError` |
| `ctx.hitl` | Stub - throws `NotImplementedError` |

## priorOutputs on join steps

After parallel fan-out, the join step receives sibling outputs as `Record<string, unknown>`. Narrow at the use site:

```typescript
async handler(input, ctx) {
  const out = ctx.priorOutputs["greet-spanish"] as { greeting?: unknown } | undefined;
  if (!out || typeof out.greeting !== "string") {
    ctx.fail({ field: "priorOutputs.greet-spanish.greeting", message: "missing sibling output" });
  }
  // ...
},
```

The engine does not pre-narrow; pipeline authors own the shape contract.

## Conventions

- Keep `schema.ts` beside `index.ts` for discoverability.
- Add `README.md` in the step folder when business rules are non-obvious (examples do this).
- Co-locate `handler.ts` with `lambdaHandlerFor` when that step has its own Lambda bundle.

## Verification

```bash
bunx pw-pipeline validate --pipeline greeter
```

## References

- `pw-pipeline-define-pipeline`, `pw-pipeline-lambda`, `pw-pipeline-parallel`
- `examples/greeter-pipeline/pipelines/greeter/steps/greet/`
