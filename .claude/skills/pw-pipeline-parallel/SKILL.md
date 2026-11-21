---
name: pw-pipeline-parallel
description: Implement parallel fan-out and join in a pipeline graph - parent coordinator rows, child SQS enqueue, CAS join, onAnyChildFailure, and priorOutputs propagation to the next step. Load when adding `parallel` arrays to graph nodes, when a join step reads sibling outputs, or when parallel joins stall or never complete (often a persistence counting bug).
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-pipeline validate:*)
metadata:
  area: pw-pipeline
---

# Parallel fan-out + join

## Graph shape

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

## Execution flow

1. Parent step handler runs. Runner keeps parent `pipeline_step_run` in `running` and wraps output as `{ parallel: true, children, parentOutput }`.
2. Lambda factory enqueues one SQS message per child; each child input is the parent's handler output.
3. Each child runs independently. When every child has a terminal status (`done` / `skipped` / `failed`), one child wins a CAS on the parent row via `Repo.tryWinParallelJoin`.
4. Winner behavior depends on `onAnyChildFailure`:
   - `"fail"` (default): any sibling failure fails the `pipeline_run`; `next` is not enqueued.
   - `"continue"`: failures ignored; `next` enqueued when all siblings terminal.
5. Before enqueueing `next`, winner loads `Repo.getSiblingOutputs(...)` into `priorOutputs` on the message body -> `ctx.priorOutputs` on the join step.

## Join step handler

```typescript
async handler(input, ctx) {
  for (const sibling of ["greet-spanish", "greet-french"] as const) {
    const out = ctx.priorOutputs[sibling] as { greeting?: string } | undefined;
    if (!out?.greeting) {
      ctx.fail({ field: `priorOutputs.${sibling}`, message: `missing ${sibling}` });
    }
  }
  return { combined: /* ... */ };
},
```

## Persistence invariant (critical)

Parallel-join SQL must use **`count(distinct step_name)`**, not `count(*)`. SQS at-least-once delivery can insert multiple `done` rows per child; `count(*)` over-counts and the join predicate never satisfies.

When changing join SQL, run the live fanout demo:

```bash
bun run infra:up && bun run infra:setup
bun run --filter @pressw/greeter-pipeline-example demo:fanout
```

## Raw SQL gotchas (repo layer)

If you touch `src/persistence/repo.ts`:

- **`db.execute` result shape** - `postgres-js` returns an array; `node-postgres` returns `{ rows }`. Normalize before indexing.
- **Array binds in tagged templates** - Drizzle inlines arrays as multiple placeholders; `ANY(${arr})` breaks. Build a quoted Postgres array literal: `ANY('{"a","b"}'::text[])` with escaped quotes.

## References

- `pw-pipeline-define-pipeline`, `pw-pipeline-define-step`, `pw-pipeline-persistence`
- `examples/greeter-pipeline/pipelines/fanout-greeter/`
