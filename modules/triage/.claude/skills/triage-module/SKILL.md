---

name: triage-module
description: Work in the triage module: job claim protocol, Jev filter, sandboxed agent, extraction, and the cloud worker. Use when you build or change triage.
---

# triage module

## Ownership

`modules/triage` owns the cloud side of a triage job. The claim protocol SQL lives in `@pw-support/db` (`triage-jobs.ts`). This module exports it for the laptop plugin as `claimJob`, `submitResult`, and `renewLease`.

## Layout

| File                                      | Role                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config.ts`                               | `loadTriageConfig(env)`: timing, Jev threshold, extraction caps, agent model                                                                                 |
| `extract.ts`                              | Plans each attachment, loads it lazily and one at a time, extracts text. Images pass through. Zip is never read                                              |
| `extract-core.ts`                         | Linear `indexOf` scanners, streaming unzip with entry caps, the PDF page cap                                                                                 |
| `extract-sandbox.ts`, `extract-worker.ts` | Run PDF and Office extraction in a Bun `Worker` with a hard timeout                                                                                          |
| `submit.ts`                               | `submitResult`: shared submit that sends a wake when an invalid result reopens the job                                                                       |
| `jev.ts`, `filter.ts`                     | Jev client and the injection filter with overlapping chunks. Fails closed                                                                                    |
| `agent-runner.ts`                         | Managed agent session: environment, stream, interrupt, abort, archive, remote-definition guard                                                               |
| `prepare.ts`                              | `prepareAgentInput`: extract, Jev filter, record judgments. The cloud and the laptop share it                                                                |
| `laptop.ts`                               | `createLaptopBackend`: implements the `LaptopBackend` port from `@pw-support/api`. Prepare for a laptop claim, human triage on a flag, and the shared submit |
| `process.ts`                              | After a cloud claim: prepare, agent, validate, submit                                                                                                        |
| `worker.ts`                               | `handleWake`, `sweepOnce`, `startSweeper`, lease heartbeat                                                                                                   |
| `runtime.ts`                              | Builds the worker deps from the environment                                                                                                                  |
| `testing/`                                | Harness, fake Jev, fake agent, generated files. Import from `@pw-support/triage/testing`                                                                     |
| `agents/support-triage/`                  | `defineAgent` definition and `sync.ts`                                                                                                                       |
| `corpus/`                                 | Injection and benign payloads for the live Jev test                                                                                                          |

## Rules

- Give the agent zero tools, zero MCP servers, and an environment with `limited` networking and an empty allowlist.
- Let deterministic code call Linear. Agent output fills enum and length-bounded fields only.
- Validate every result with the contracts triage result schema through `submitTriageResult`, laptop or cloud.
- Fail closed. A flagged request, a Jev error, a timeout, or a missing key completes the job as human triage and starts no session.
- Pass customer content to the agent only inside the untrusted tags that `buildUserContent` writes.
- Judge everything the agent reads: the request text, every attachment filename, and every extracted document. Chunks overlap by 12 percent.
- Send an image to the agent only when Jev recorded a non-flagged judgment for it. Record every other image as `skipped` in `support.judgments` with a reason.
- Keep one preparation function. A laptop claim calls `prepareAgentInput` through `createLaptopBackend`, so the filter logic never forks. A laptop gets content only when the filter passes. Any other outcome completes the job as human triage and returns no content.
- Build the laptop system prompt with `buildTriageSystemPrompt("tool")` from contracts. The cloud agent uses the `"json"` delivery of the same builder.
- Run PDF and Office extraction in the Worker sandbox. Never scan XML with a regex. Load attachments from storage lazily and one at a time.
- Refuse to run a session unless the remote agent has zero tools, zero MCP servers, and zero skills. Complete the job with `agent_definition_unsafe` in that case.
- Release a job for a transient failure, then send a fresh wake with backoff. Abort the agent when the lease heartbeat loses ownership.
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
