---
name: pw-agents-create-agent
description: Author a new managed agent inside a project that depends on `@pressw-llc/managed-agents`, then publish it idempotently. Load when scaffolding a new `agents/<name>/` folder, when editing `agent.ts` to change the persona / model / tools / MCP servers / skills / metadata, when running `bunx pw-managed-agents sync` (or the generated `sync.ts`), or when reasoning about the identity-record lifecycle (created / updated / noop). Walks through the CLI generator -> `defineAgent` -> `syncAgent` flow and the identity semantics that make re-running sync from a fresh checkout safe, including keeping identity outside the repo with an `AgentStore`.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-managed-agents:*)
metadata:
  area: pw-managed-agents
  api-beta: managed-agents-2026-04-01
---

# Create a managed agent

Define one managed agent as a typed module under `agents/<name>/`, then publish it through the library's idempotent sync flow. Re-running `sync` only allocates a new agent version when the definition actually changed.

## Phase 1 - Gather Requirements

Ask the developer:

- **Agent name** - kebab-case, surfaced in events and dashboards. Cannot be cleared on update.
- **Model** - default is `claude-sonnet-4-6` from the project config. Confirm whether escalation to a stronger model is needed. Cannot be cleared on update.
- **System prompt** - durable persona / role description. Load `pw-agents-context` before authoring this.
- **Tools** - which built-in toolset entries the agent gets. Coordinators that delegate need `{ type: "agent_toolset_20260401" }` plus any first-party Anthropic tools. Custom tools live behind MCP - see `pw-agents-managed-agent-skills`.
- **MCP servers** - URL + name for any MCP server the agent should call.
- **Skills** - kebab-case names of managed-agent skills the runtime should progressively disclose. The folder basename of each skill under `<skillsDir>/` MUST match the entry here.
- **Metadata** - `Record<string, string>` for client-side tracking (`owner`, `repo_path`, `cost_center`). The model does not see this.
- **Multiagent roster** - only if this agent coordinates. See `pw-agents-multiagent` for the coordinator-specific helper.
- **Description** - one-line external label, optional and replaceable.

If any of `name` / `model` / `system` is unclear, stop and resolve before scaffolding. Those three are the spine of the definition.

## Phase 2 - Author

### 2a. Scaffold the folder

```bash
bunx pw-managed-agents new agent code-reviewer
```

This calls `runNewAgent` from `src/cli/commands/new-agent.ts`, which:

- Resolves the agents directory from `pw-managed-agents.config.ts` (or `./agents` / `./src/agents` if there is no config).
- Lowercases / kebab-cases the name.
- Renders the templates under `src/generators/templates/agent/` into `<agentsDir>/code-reviewer/`: `agent.ts`, `sync.ts`, `run.ts`, `README.md`.
- Passes `--force` through if existing files need to be overwritten.

Override the model at scaffold time:

```bash
bunx pw-managed-agents new agent code-reviewer --model claude-opus-4-7
```

The default model used by the template falls back to `agentDefaults.model` from the config, then to `claude-sonnet-4-6`.

### 2b. Edit `agent.ts`

The generator emits:

```typescript
import { defineAgent } from "@pressw-llc/managed-agents";

export const definition = defineAgent({
  name: "Code Reviewer",
  model: "claude-sonnet-4-6",
  system: "TODO: replace with the agent's persona.",
  tools: [{ type: "agent_toolset_20260401" }],
  mcp_servers: [],
  skills: [],
  metadata: {
    repo_path: "agents/code-reviewer",
  },
});
```

`defineAgent<T>(definition: T): T` is an identity helper exported from `core/agents/define.ts`. The runtime returns the input unchanged; the value is the IDE typing - every field is typed against the live SDK's `beta.agents.create` request body, so future SDK additions (new tool variants, multiagent options) light up automatically.

Edit the placeholder, attach skills / MCP servers, and consult `pw-agents-context` for what belongs where:

```typescript
import { defineAgent } from "@pressw-llc/managed-agents";

export const definition = defineAgent({
  name: "Code Reviewer",
  model: "claude-sonnet-4-6",
  system: [
    "You are a senior code reviewer for this codebase.",
    "Prioritize security and correctness over style.",
    "Defer style nits to the project formatter.",
  ].join(" "),
  description: "Reviews PRs against project conventions.",
  tools: [{ type: "agent_toolset_20260401" }],
  mcp_servers: [
    { type: "url", name: "repo-mcp", url: process.env.REPO_MCP_URL ?? "http://localhost:8080/mcp" },
  ],
  skills: ["repo-review-checklist"],
  metadata: {
    owner: "platform",
    repo_path: "agents/code-reviewer",
  },
});
```

### 2c. Publish via `sync`

The CLI sync command is the developer-facing entry point:

```bash
bunx pw-managed-agents sync code-reviewer
```

It dynamically imports `agents/code-reviewer/agent.ts`, reads the exported `definition`, and calls `syncAgent` (from `core/agents/sync.ts`) with the agent's `agent.lock.json` path. `syncAgent` also accepts an `AgentStore` in place of that path, for keeping identity somewhere a discarded CI checkout cannot lose. On AWS that is `ssmAgentStore` from `@pressw-llc/managed-agents/aws`, which puts the id in the target account's Parameter Store and leaves no lock file in the repo.

For programmatic publishing, run the generated `sync.ts` directly:

```bash
bun agents/code-reviewer/sync.ts
```

Both paths land in the same `syncAgent` call. Its contract from `core/agents/sync.ts`:

- **No recorded identity** -> `beta.agents.create(definition)`, record it, return `{ action: "created", lock }`.
- **Recorded identity** -> check its recorded target, then `beta.agents.update(id, definition)`, re-record the version the API returned (same number on a no-op, incremented on a real change), return `{ action: "updated" | "noop", lock }`. No `version` is sent — see the pitfall below.

Lock file shape (committed to git):

```json
{
  "id": "agt_...",
  "version": 3,
  "name": "Code Reviewer",
  "updated_at": "2026-05-14T12:00:00.000Z",
  "target": { "name": "default", "mode": "api-key" }
}
```

`syncAgent` accepts an optional `{ client, logger, target }`. The CLI passes the project-config-aware client; programmatic callers can stage their own client via `createClient` (see `pw-agents-auth`) when they need a fixed mode or extra headers.

### 2c. Publishing to more than one workspace

An agent id only exists inside the workspace that issued it, so locks are keyed by **deploy target**. `agent.lock.json` is the `default` target; `agent.<target>.lock.json` is a named one. Derive the path with `agentLockPath(dirPath, target)` — never by concatenating a filename.

```bash
bunx pw-managed-agents sync code-reviewer --target staging               # agent.staging.lock.json
bunx pw-managed-agents sync code-reviewer --target prod --new-target     # agent.prod.lock.json
```

`--new-target` is required for a target that has no lock yet *once other targets do*. Target names are free text, so `--target prd` is a plausible typo, and a typo points at a lock file that does not exist - which would otherwise mean "publish a brand-new agent" and exit green. That duplicate then gets read at build time and serves traffic in place of the intended agent. A first publish needs no flag; creating a *second* identity does.

The target resolves as `--target` -> `PW_AGENTS_TARGET` -> `target` in `pw-managed-agents.config.ts` -> `default`, and every lock records which target its id belongs to. If the recorded target disagrees with the authenticated client — name, auth mode, workspace, or region — `syncAgent` throws `LockTargetMismatchError` before any API call. In `api-key` mode there is no discoverable workspace, so two API-key targets are told apart only by their declared names.

A lock with no `target` block predates the feature. Sync adopts it, but only after `retrieve` confirms the id exists in the target being published to, so a lock moved to the wrong target is refused rather than published.

### 2d. Sync all agents

`bunx pw-managed-agents sync` without a positional name walks every `<agentsDir>/<name>/agent.ts` and syncs each one. Useful in CI after a refactor that touched multiple agents.

## Phase 3 - Verify

### Confirm the publish landed

```bash
bunx pw-managed-agents list
```

The local agents table prints `<name> <id> v<version> <updated_at>` for every agent whose `agent.lock.json` exists. Unsynced agents print `unsynced` in the version column.

### Inspect the canonical record

```typescript
import { readAgentLock, retrieveAgent } from "@pressw-llc/managed-agents";

const lock = readAgentLock("./agents/code-reviewer/agent.lock.json");
if (!lock) throw new Error("not synced yet");

const agent = await retrieveAgent(lock.id);
console.log(`canonical version=${agent.version} skills=${(agent.skills ?? []).join(",")}`);
```

Assertions:

- `agent.name`, and the fields `agent.ts` declares, match what you published. The recorded `version` may lag the live agent if something else updated it — that drift is harmless and the next sync reconciles it, because `syncAgent` sends no version token.
- `agent.name`, `agent.system`, `agent.skills`, `agent.mcp_servers`, `agent.metadata` match what `agent.ts` declares.

### Smoke-test

```bash
bunx pw-managed-agents run code-reviewer -m "Introduce yourself."
```

`run.ts` (the generator-emitted smoke script) does the same thing without going through the CLI:

```bash
bun agents/code-reviewer/run.ts "Introduce yourself."
```

Both call `runOneShot` against an ephemeral environment, archive both the environment and the session on exit. See `pw-agents-sessions` for what `runOneShot` actually does.

## Pitfalls

- **The record tracks state, not content.** The library does not hash the definition before sending; it sends the full body every time and lets the API decide whether to allocate a new version. A no-op shows up as `{ action: "noop" }` and a `version` that did not change — and writes nothing, so a committed lock produces no diff and no commit.
- **Array fields are fully replaced, not merged.** `tools`, `mcp_servers`, `skills`, and `multiagent.agents` are replaced wholesale on `update`. Always derive these arrays from the `definition` constant in `agent.ts` so partial updates never happen by accident. See `pw-agents-context` for the per-field replace / merge / clear table.
- **`metadata` merges per key.** Setting `metadata: { owner: "x" }` leaves other keys intact. Delete a key by setting its value to `""`; wipe metadata by setting every key to `""`.
- **`model` and `name` cannot be cleared.** They can be changed on update but never set to null. To rename without losing history, update with the new name and let `version` increment.
- **Folder name vs `definition.name`.** The CLI uses the folder basename to find the agent; `agent.ts` exports the human-readable `name`. They do not have to match (the generator capitalizes the human name). What matters is the folder basename equals what `sync <name>` and `run <name>` take as a positional arg.
- **`sync.ts` and the CLI both work; pick one and stick to it in CI.** They take the same identity record.
- **Don't commit `.env`; do commit every `agent*.lock.json` you keep in the repo.** The record answers "which API id does this folder map to *in this target*", and without it a publish creates a duplicate instead of updating. Committing one target's lock and gitignoring another's is how a target silently loses its id. In CI, prefer an `AgentStore` backed by the target account — `ssmAgentStore({ prefix, target, region })` from `@pressw-llc/managed-agents/aws`. The runner's checkout is discarded, so a lock file survives only by being committed back: a commit on every deploy, which on an auto-building branch is a build the same deploy then races when it verifies. With a store there is no lock file to commit and nothing to gitignore.
- **Read the lock through `readAgentLockForTarget(dirPath, target)` at build/synth time.** A hardcoded `agent.lock.json` path in a deploy step injects the default target's id into every environment; the helper reads the right lock and refuses one whose recorded target does not match.
- **`version` on update is optional, and `syncAgent` deliberately omits it.** It is an optimistic-concurrency token, not a required field: supply it and the update fails with `409 Concurrent modification detected` unless it matches the server exactly — including when the definition you are sending is byte-identical, because the API compares the token and not the content. Omitting it applies the update unconditionally, which is the documented shape for a deploy that owns the agent. Publishing still allocates a server-side version every time, so history and version-pinned sessions are unaffected. Hand-roll the token only for an interactive caller that genuinely wants to lose the race.
- **Archive is not delete.** `archiveAgent(id)` makes the agent read-only and blocks new sessions; existing sessions referencing it keep running. To stop in-flight work, interrupt the session itself - see `pw-agents-sessions`.
- **Project config is loaded by walking up from CWD.** The CLI looks for `pw-managed-agents.config.ts` in parent directories. Running `bunx pw-managed-agents sync` from a deep subdirectory works as long as the config is reachable upward.

## References

- /docs/en/managed-agents/agent-setup - https://platform.claude.com/docs/en/managed-agents/agent-setup
- /docs/en/managed-agents/multi-agent - https://platform.claude.com/docs/en/managed-agents/multi-agent (coordinator config + caps)
- `packages/pw-managed-agents/src/core/agents/` - `defineAgent`, `syncAgent`, lock helpers, `retrieveAgent`, `archiveAgent`
- `packages/pw-managed-agents/src/generators/templates/agent/` - the canonical agent folder shape
- Related skills: `pw-agents-auth`, `pw-agents-context`, `pw-agents-sessions`, `pw-agents-managed-agent-skills`, `pw-agents-multiagent`
