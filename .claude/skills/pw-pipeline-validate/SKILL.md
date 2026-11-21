---
name: pw-pipeline-validate
description: Run build-time pipeline validation with `bunx pw-pipeline validate` - graph/step file presence, managed-agent-on-Fargate, terminal flags, and agent-step shape checks; integrate into CI. Load before opening a PR that touches pipelines, when CI fails on validator errors, or when choosing --skip-agent-resolution for environments without agent lock files.
allowed-tools: Read, Write, Edit, Bash(bunx pw-pipeline validate:*)
metadata:
  area: pw-pipeline
---

# Validate pipelines

```bash
bunx pw-pipeline validate
bunx pw-pipeline validate --pipeline greeter
bunx pw-pipeline validate --pipelines-dir workflows
bunx pw-pipeline validate --skip-agent-resolution
```

Walks `<pipelinesDir>/*/pipeline.config.ts` (default `./pipelines`).

## Checks implemented today

| Check | Code | What it catches |
| --- | --- | --- |
| missing-step-file | 1 | Graph step name with no `steps/<name>/index.ts` |
| managed-agent-requires-fargate | 5 | `defineAgentStep` + `managed` on `runtime: "lambda"` |
| missing-terminal-flag | 6 | Leaf step without `terminal: true` |
| invalid-agent-step-shape | 8 | Broken `agent` field, missing schemas / `buildPrompt` |

Parallel children and branch nodes have documented exemptions (see README).

## CI integration

Add to the consumer's CI pipeline:

```bash
bunx pw-pipeline validate
```

Fail the job on any error. Use `--skip-agent-resolution` only when step modules cannot be imported (no agent locks in CI) - you lose managed-agent field validation for that run.

## Pipelines dir precedence

`API arg > CLI --pipelines-dir > PW_PIPELINES_DIR > ./pipelines`

Re-export: `DEFAULT_PIPELINES_DIR`, `resolvePipelinesDir()` from the package root.

## Roadmap (not enforced yet)

Checks 2, 3, 4, 7 (schema assignability, branch reachability, invokePipeline target, CDK queue declarations) are planned; do not assume they run today.

## References

- `pw-pipeline-define-pipeline`, `pw-pipeline-agent-steps`
- `tests/unit/validate-*.test.ts` in the package
