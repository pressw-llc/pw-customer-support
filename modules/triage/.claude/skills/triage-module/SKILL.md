---

name: triage-module
description: Work in the triage module: job claim protocol, Jev filter, sandboxed agent, and Linear ticket creation. Use when you build or change triage.
---

# triage module

## Ownership

`modules/triage` owns triage jobs. The intended module holds the job table claim, the lease, the delay and backoff, the Jev injection filter, the sandboxed managed agent, result validation, and the Linear adapter outbound.

## Rules

- Give the agent zero tools, zero MCP servers, and restricted networking.
- Let deterministic code call Linear. Agent output fills enum and length-bounded fields only.
- Validate every result with the contracts triage result schema, laptop or cloud.
- Add `@pressw-llc/pipeline` and `@pressw-llc/managed-agents` in Phase 2. Pin both to exact versions.
- Set the pipeline tenant explicitly on every run.
- Use the pipelines authoring skills in the root `.claude/skills`.

## Commands

```bash
bun test modules/triage
```
