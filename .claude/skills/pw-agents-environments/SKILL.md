---
name: pw-agents-environments
description: Create, attach, reuse, and archive the sandboxed filesystem environments that managed-agent sessions execute in - using `createEnvironment / listEnvironments / archiveEnvironment` from `@pressw-llc/managed-agents`. Load whenever a session needs a working directory (ephemeral per-session or long-lived shared), when deciding between recreating vs reusing an environment for isolation / cost / persistence trade-offs, or when persisting an env id alongside an agent so subsequent runs do not orphan a fresh sandbox on every invocation.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-managed-agents:*)
metadata:
  area: pw-managed-agents
  api-beta: managed-agents-2026-04-01
---

# Managed environments

Environments are the sandboxed filesystem + runtime a session binds to. Every `sessions.create` call needs an `environment_id`. Environment lifetime is independent of session lifetime - the developer's job to track.

> The environments surface is part of the `managed-agents-2026-04-01` beta. The library wrappers track the current SDK shape; if the SDK params type drifts, the typechecker catches it on the next `bun run typecheck`. The conceptual workflow below is stable; field names (filesystem seed, networking variants, runtime images) are not codified in this skill because the beta surface is still moving.

## Phase 1 - Gather Requirements

Before creating an environment, decide:

- **Ephemeral vs reusable** - throwaway per session (clean slate, no side effects) or long-lived (cached deps, accumulated artifacts, faster cold starts).
- **Per-agent vs shared** - one environment scoped to a single agent, or one shared across multiple agents in a multiagent session. All agents in a multiagent session share the same environment.
- **Filesystem seed** - blank, seeded from a git snapshot, or pre-baked. Confirm the live field set against the docs before passing anything beyond the library's defaults.
- **Concurrency expectations** - how many sessions attach simultaneously. Shared environments are a single filesystem; concurrent writes race.
- **Retention** - when to archive. Long-lived environments accumulate cost; orphaned ones accumulate silently in `listEnvironments`.

If the agent has not been published, run `pw-agents-create-agent` first. If files need to be seeded into the env, plan that step now and load `pw-agents-files` after creating the env.

## Phase 2 - Author

### 2a. Ephemeral via the session helpers (default)

The simplest path is to let `runOneShot` / `runMultiTurn` create and archive the env for the developer:

```typescript
import { readAgentLock, runOneShot } from "@pressw-llc/managed-agents";

const lock = readAgentLock("./agents/code-reviewer/agent.lock.json");
if (!lock) throw new Error("sync first");

const result = await runOneShot({
  agent: lock.id,
  prompt: "Review the diff and report.",
  environment: { create: true },
});
```

The helper creates the env, attaches the session, and archives both in `finally`. See `pw-agents-sessions` for the full lifecycle.

### 2b. Explicit ephemeral env

When the developer needs the env id during the run (to upload files, inspect listings, etc.), create it first and pass the id in:

```typescript
import {
  archiveEnvironment,
  createEnvironment,
  readAgentLock,
  runOneShot,
} from "@pressw-llc/managed-agents";

const lock = readAgentLock("./agents/code-reviewer/agent.lock.json");
if (!lock) throw new Error("sync first");

const env = await createEnvironment();

try {
  const result = await runOneShot({
    agent: lock.id,
    prompt: "Read /workspace/inputs/spec.md and respond.",
    environment: { id: env.id },
    archiveEnvironmentOnExit: false,
  });
  console.log(result.textOutput);
} finally {
  await archiveEnvironment(env.id);
}
```

`createEnvironment()` defaults to `{ config: { type: "cloud", networking: { type: "unrestricted" } }, name: "pw-mac-env-<timestamp>" }`. See `core/environments/create.ts` for the exact defaults. Override `name` / `config` when the developer needs an env with restricted networking or a specific cloud config.

```typescript
const env = await createEnvironment({
  name: "research-pair-shared",
  config: { type: "cloud", networking: { type: "restricted" } },
});
```

### 2c. Long-lived shared env

For a multi-agent project where the same workspace should persist across runs, create the env once and pin its id to a manifest:

```typescript
import { writeFileSync } from "node:fs";
import { createEnvironment } from "@pressw-llc/managed-agents";

const env = await createEnvironment({ name: "platform-shared-workspace" });
writeFileSync(
  "./agents/_environments/platform.json",
  `${JSON.stringify({ id: env.id, name: env.name, createdAt: new Date().toISOString() }, null, 2)}\n`,
);
```

Subsequent sessions reuse the id:

```typescript
import { readFileSync } from "node:fs";
import { readAgentLock, runMultiTurn } from "@pressw-llc/managed-agents";

const envManifest = JSON.parse(readFileSync("./agents/_environments/platform.json", "utf-8")) as {
  id: string;
};
const lock = readAgentLock("./agents/researcher/agent.lock.json");
if (!lock) throw new Error("sync first");

await runMultiTurn({
  agent: lock.id,
  prompts: ["Index the repo.", "Now summarize."],
  environment: { id: envManifest.id },
});
```

When `environment.id` is passed instead of `create: true`, the session helpers default `archiveEnvironmentOnExit` to `false`. The shared env outlives every session attached to it.

### 2d. Inspect existing environments

```typescript
import { listEnvironments } from "@pressw-llc/managed-agents";

const envs = await listEnvironments({ limit: 25 });
for (const e of envs) {
  console.log(`${e.id} ${e.name}`);
}
```

`listEnvironments` collects the SDK paginator into an array internally - convenient for short lists, but switch to `client.sdk.beta.environments.list(...)` for unbounded iteration when the org has many envs.

### 2e. Archive cleanup

```typescript
import { archiveEnvironment, listEnvironments } from "@pressw-llc/managed-agents";

const envs = await listEnvironments();
for (const env of envs) {
  if (env.name?.startsWith("pw-mac-env-")) {
    await archiveEnvironment(env.id);
  }
}
```

Run a cleanup pass like this if smoke tests have leaked auto-named envs. The default name `pw-mac-env-<iso-timestamp>` is the marker.

## Phase 3 - Verify

After creating an env, confirm it shows up in the listing and that a smoke session attaches successfully:

```typescript
import { createEnvironment, listEnvironments, readAgentLock, runOneShot } from "@pressw-llc/managed-agents";

const env = await createEnvironment({ name: "smoke" });

const envs = await listEnvironments({ limit: 5 });
const seen = envs.find((e) => e.id === env.id);
if (!seen) throw new Error(`env ${env.id} missing from list`);

const lock = readAgentLock("./agents/probe/agent.lock.json");
if (!lock) throw new Error("publish a probe agent first");
const result = await runOneShot({
  agent: lock.id,
  prompt: "List the working directory contents and exit.",
  environment: { id: env.id },
  archiveEnvironmentOnExit: true,
});
console.log(result.textOutput);
```

Assertions:

- The env id is present in `listEnvironments`.
- The smoke session reports the expected working-directory contents (for shared envs, prior runs' writes should be visible).
- `archiveEnvironmentOnExit: true` here is intentional: the smoke env is single-use.

## Pitfalls

- **Environment lifetime is independent of session lifetime.** Archiving a session does not archive its environment. Orphaned envs accumulate silently. Track ids in a manifest and reap.
- **Reuse means side effects persist.** Two sessions sharing an env see each other's writes, caches, and partial work. Intentional for warm starts; surprising for evals and untrusted input.
- **Per-org sandboxing.** Environments are scoped to the credentials' org. A SigV4 client for org A cannot attach to an env owned by org B.
- **Concurrent writes race.** Multiple sessions on the same env write to one filesystem with no transactional layer. Coordinate or serialize when correctness matters.
- **Archive vs delete.** `archiveEnvironment` frees runtime resources but the env may remain visible in listings depending on the live spec. Confirm semantics before depending on "archived means gone".
- **Cost shape.** Long-lived envs bill on retention; ephemeral envs bill on creation churn. Pick the shape that matches usage and document it in the agent's README.
- **Seed drift.** If the env was seeded from a git snapshot, that snapshot is frozen at create time. Re-create (or run a sync step at session start) when the upstream repo moves.
- **Default networking is `unrestricted`.** `createEnvironment()` with no args opens the network. If the workload should be sandboxed, pass `config: { type: "cloud", networking: { type: "restricted" } }` (or whatever the live spec calls the locked-down variant - re-fetch the docs page first).
- **Beta surface is moving.** The library wraps the params type from the live SDK; if a field changes shape, the typechecker catches it. Avoid hardcoding config field names in long-term agent definitions until the surface stabilizes - prefer pulling defaults from a central helper and updating in one place.
- **`archiveEnvironmentOnExit` defaults flip.** With `environment: { create: true }` the helper archives the env on exit. With `environment: { id }` it does not. Override explicitly when sharing matters.

## References

- /docs/en/managed-agents/environments - https://platform.claude.com/docs/en/managed-agents/environments
- /docs/en/managed-agents/agent-setup - https://platform.claude.com/docs/en/managed-agents/agent-setup
- `packages/pw-managed-agents/src/core/environments/` - `createEnvironment`, `listEnvironments`, `archiveEnvironment` and the params type
- `packages/pw-managed-agents/src/core/sessions/run-one-shot.ts` - the canonical create-and-attach-and-archive pattern the helpers implement
- Related skills: `pw-agents-create-agent`, `pw-agents-sessions`, `pw-agents-files`, `pw-agents-multiagent`
