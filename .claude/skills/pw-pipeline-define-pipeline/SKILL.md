---
name: pw-pipeline-define-pipeline
description: Author a pipeline module with `definePipeline` - graph nodes, SQS triggers, terminal flags, branching, parallel blocks, and `invokePipeline` composition. Load when creating or editing `pipelines/<name>/pipeline.config.ts`, when adding nodes to `graph`, when choosing `runtime: "lambda" | "fargate"`, or when wiring `next`, `parallel`, `branch`, or `invokePipeline` fields.
allowed-tools: Read, Write, Edit, Bash(bunx pw-pipeline validate:*)
metadata:
  area: pw-pipeline
---

# Define a pipeline

A pipeline is a TypeScript module that default-exports the result of `definePipeline({ ... })`. The folder name should match `name`.

## Minimal linear pipeline

```typescript
import { definePipeline } from "@pressw-llc/pipeline/define";

export default definePipeline({
  name: "greeter",
  trigger: { sqs: { queue: "greeter-requests" } },
  parentTaskRun: false,
  graph: {
    greet: { runtime: "lambda", terminal: true },
  },
});
```

- **`trigger.sqs.queue`** - logical queue name used by infra setup and `envQueueResolver`. CDK / `infra/setup.ts` materializes URLs into env vars.
- **`parentTaskRun`** - when `true`, the engine creates a `task_run` row that aggregates child `pipeline_run` rows (useful when one user-visible unit spans multiple pipelines).
- **`graph`** - flat record keyed by step name. Keys are the canonical step identifiers everywhere (SQS bodies, persistence, validators).

## Node shapes

| Field | Purpose |
| --- | --- |
| `runtime` | `"lambda"` or `"fargate"`. Managed-agent steps must use Fargate (validator check 5). |
| `terminal: true` | Required when the step has no outgoing edge (check 6). Parallel children are exempt. |
| `next` | Linear successor step name. |
| `branch` | Predicate-driven routing (see README). |
| `parallel` | Array of child step names; parent handler fans out (see `pw-pipeline-parallel`). |
| `onAnyChildFailure` | `"fail"` (default) or `"continue"` on parallel blocks. |
| `invokePipeline` | Fire-and-forget child pipeline per item (`awaitCompletion: false` only today). |

## Parallel block (sketch)

```typescript
graph: {
  "stage-2-fanout": {
    runtime: "lambda",
    parallel: ["stage-2-fanout/ags", "stage-2-fanout/hellodata"],
    next: "stage-3",
    onAnyChildFailure: "fail",
  },
  "stage-2-fanout/ags": { runtime: "lambda" },
  "stage-2-fanout/hellodata": { runtime: "lambda" },
  "stage-3": { runtime: "lambda", terminal: true },
},
```

Slash-separated step names are conventional for namespacing parallel children.

## InvokePipeline (fire-and-forget)

```typescript
"fanout-enrich": {
  runtime: "lambda",
  invokePipeline: {
    pipeline: "property-enrichment",
    foreach: (out: { newPropertyIds: string[] }) => out.newPropertyIds,
    mapInput: (id: string) => ({ targetRecordId: id }),
    awaitCompletion: false,
  },
  next: "register-search",
},
```

`awaitCompletion: true` throws `NotImplementedError` today.

## Pipelines directory resolution

| Channel | Value |
| --- | --- |
| Default | `./pipelines` |
| Env | `PW_PIPELINES_DIR` |
| CLI | `bunx pw-pipeline validate --pipelines-dir workflows` |
| API | `walkPipelines(root, { pipelinesDir: "workflows" })` |

Precedence: API arg > CLI flag > env > default.

## Verification

```bash
bunx pw-pipeline validate --pipeline greeter
```

Fix `missing-step-file`, `missing-terminal-flag`, and `managed-agent-requires-fargate` before merging.

## References

- `pw-pipeline-define-step`, `pw-pipeline-parallel`, `pw-pipeline-validate`
- `examples/greeter-pipeline/pipelines/fanout-greeter/pipeline.config.ts`
