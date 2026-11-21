---
name: pw-pipeline-overview
description: Entry-point routing skill for `@pressw-llc/pipeline`. Load first when a developer mentions defining, validating, deploying, or debugging a TypeScript pipeline on Lambda or Fargate; when they install the package with `bun add @pressw-llc/pipeline`; when they reference the `pw-pipeline` CLI binary; or when they cite a `pipelines/<name>/` directory, `pipeline.config.ts`, or `steps/<step>/index.ts`. Routes to the right sibling `pw-pipeline-*` skill based on intent (graph authoring, steps, agent steps, Lambda wiring, Fargate workers, parallel joins, Postgres persistence, validation, local dev).
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-pipeline:*)
metadata:
  area: pw-pipeline
---

# `@pressw-llc/pipeline` - overview

`@pressw-llc/pipeline` is a TypeScript pipeline engine for AWS. Pipelines are defined as TypeScript modules with a flat `graph` record; the engine runs each step on Lambda or Fargate, persists per-step state in Postgres, and treats Anthropic Managed Agents as first-class steps via an injected session factory.

These skills are documentation for the AI coding assistant working inside a project that uses the library. Start here, then load the topic-specific skill below.

## When to load which skill

| Developer intent | Skill |
| --- | --- |
| "Define a new pipeline / graph / trigger / terminal / invokePipeline" | `pw-pipeline-define-pipeline` |
| "Add a step / handler / Zod schema / ctx.activityLog" | `pw-pipeline-define-step` |
| "Wire a managed agent step / defineAgentStep / agentSessionFactory" | `pw-pipeline-agent-steps` |
| "Lambda handler / bundle / structured vs N:M / registry" | `pw-pipeline-lambda` |
| "Fargate worker / long poll / visibility heartbeat / credential refresh" | `pw-pipeline-fargate` |
| "Parallel fan-out / join / priorOutputs / sibling outputs" | `pw-pipeline-parallel` |
| "Postgres / migrations / Drizzle / repo SQL gotchas" | `pw-pipeline-persistence` |
| "Validate before deploy / CI / validator checks" | `pw-pipeline-validate` |
| "Run locally / docker compose / LocalStack / examples" | `pw-pipeline-local-dev` |

Skill names map 1:1 to folder names under `.claude/skills/` after `bunx pw-pipeline skills install`.

## Quick start

```bash
bun add @pressw-llc/pipeline
bunx pw-pipeline skills install   # optional: copy authoring skills into ./.claude/skills/

# scaffold layout (manual today; CLI `new` / `new-step` land in a follow-up)
mkdir -p pipelines/greeter/steps/greet
```

```typescript
// pipelines/greeter/pipeline.config.ts
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

```bash
bunx pw-pipeline validate
```

See `examples/greeter-pipeline/` in the monorepo for runnable pipelines (linear, fanout, Fargate).

## Project layout

```
pipelines/
  greeter/
    pipeline.config.ts       default export from definePipeline(...)
    steps/
      greet/
        index.ts               default export from defineStep(...) or defineAgentStep(...)
        schema.ts              Zod input/output (convention)
        handler.ts             optional: lambdaHandlerFor entry when co-located
    lambda-entries/            optional: one file per Lambda bundle
    fargate-entries/           optional: fargateMain entry per long-running step
```

Default pipelines directory: `./pipelines`. Override with `PW_PIPELINES_DIR`, `--pipelines-dir`, or `resolvePipelinesDir()`.

## Install authoring skills

```bash
bunx pw-pipeline skills install
```

Copies this package's `skills/` tree into `./.claude/skills/`. Authoring skills are local docs for the coding agent; they are not uploaded anywhere.

## CLI command reference

```
pw-pipeline validate [--pipeline <name>] [--pipelines-dir <dir>] [--skip-agent-resolution]
pw-pipeline skills install [--destination <path>] [--force] [--dry-run]
pw-pipeline new                    (scaffold pipeline - not yet implemented)
pw-pipeline new-step               (scaffold step - not yet implemented)
pw-pipeline migrate                (run Drizzle migrations - not yet implemented)
pw-pipeline run                    (in-process local run - not yet implemented)
pw-pipeline trace                  (print run rows - not yet implemented)
```

`skills install` and `validate` (without agent resolution) are offline-safe. Agent-field validation dynamic-imports step modules.

## References

- Package `README.md` for the canonical API walkthrough
- `examples/greeter-pipeline/`, `examples/property-enrichment/`, `examples/property-summary/`
- Sibling skills: `pw-pipeline-define-pipeline`, `pw-pipeline-define-step`, `pw-pipeline-agent-steps`, `pw-pipeline-lambda`, `pw-pipeline-fargate`, `pw-pipeline-parallel`, `pw-pipeline-persistence`, `pw-pipeline-validate`, `pw-pipeline-local-dev`
- For managed agents: `@pressw-llc/managed-agents` and `bunx pw-managed-agents skills install`
