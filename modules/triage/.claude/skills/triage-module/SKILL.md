---

name: triage-module
description: Work in the triage module: job claim protocol, Jev filter, sandboxed agent, extraction, and the cloud worker. Use when you build or change triage.
---

# triage module

## Ownership

`modules/triage` owns the cloud side of a triage job. The claim protocol SQL lives in `@pw-support/db` (`triage-jobs.ts`). This module exports it for the laptop plugin as `claimJob`, `submitResult`, and `renewLease`.

## Layout

| File                     | Role                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `config.ts`              | `loadTriageConfig(env)`: timing, Jev threshold, extraction caps, agent model                       |
| `extract.ts`             | Deterministic text extraction: PDF, docx, xlsx, pptx, text. Images pass through. Zip is never read |
| `jev.ts`, `filter.ts`    | Jev client and the injection filter. Fails closed                                                  |
| `agent-runner.ts`        | Managed agent session: environment, stream, interrupt, archive                                     |
| `process.ts`             | After a cloud claim: extract, filter, agent, validate, submit                                      |
| `worker.ts`              | `handleWake`, `sweepOnce`, `startSweeper`, lease heartbeat                                         |
| `runtime.ts`             | Builds the worker deps from the environment                                                        |
| `testing/`               | Harness, fake Jev, fake agent, generated PDF and Office files                                      |
| `agents/support-triage/` | `defineAgent` definition and `sync.ts`                                                             |
| `corpus/`                | Injection and benign payloads for the live Jev test                                                |

## Rules

- Give the agent zero tools, zero MCP servers, and an environment with `limited` networking and an empty allowlist.
- Let deterministic code call Linear. Agent output fills enum and length-bounded fields only.
- Validate every result with the contracts triage result schema through `submitTriageResult`, laptop or cloud.
- Fail closed. A flagged request, a Jev error, a timeout, or a missing key completes the job as human triage and starts no session.
- Pass customer content to the agent only inside the untrusted tags that `buildUserContent` writes.
- Pin `@pressw-llc/pipeline`, `@pressw-llc/managed-agents`, and `@anthropic-ai/sdk` to exact versions.
- The worker runs without a pipeline repo. The job table owns state, so the engine writes no run rows and the tenant default of T16 never lands in a table.
- Inject the clock through `now` in tests. Never sleep in a test for a delay.

## Commands

```bash
bun test modules/triage
bun run dev:worker
bun run agent:sync
bun run validate:phase-2
```
