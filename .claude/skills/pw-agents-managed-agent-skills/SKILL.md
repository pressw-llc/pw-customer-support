---
name: pw-agents-managed-agent-skills
description: Author and attach runtime tool surfaces to a managed agent - Anthropic-side custom Skills (uploaded via `defineSkill / syncSkill`) and MCP servers (configured on the agent definition's `mcp_servers` array). These are NOT the same as the authoring skills bundled under `packages/pw-managed-agents/skills/`. Load when scaffolding a new managed-agent skill folder with `bunx pw-managed-agents new skill`, when publishing or versioning a skill with `bunx pw-managed-agents skills sync`, when attaching skills + MCP servers in `agent.ts`, or when debugging why a skill name does not resolve at session start.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-managed-agents:*)
metadata:
  area: pw-managed-agents
  api-beta: managed-agents-2026-04-01
---

# Skills (uploaded to Anthropic) and MCP servers

This skill covers two runtime tool surfaces on a managed agent:

1. **Custom Skills** the agent uses at runtime, uploaded to Anthropic via `defineSkill` + `syncSkill` (from `@pressw-llc/managed-agents`).
2. **MCP servers** the agent calls during a session, configured in `agent.ts` under `mcp_servers`.

These are NOT the same thing as the authoring skills in `packages/pw-managed-agents/skills/`. Authoring skills live in the consumer's repo (copied via `bunx pw-managed-agents skills install`) and guide the AI coding assistant that writes the developer's code. Managed-agent skills live in the consumer's repo too, but `bunx pw-managed-agents skills sync` zips them up and uploads them to Anthropic where the runtime resolves them inside a session.

| | Managed-agent skill (`<skillsDir>/<name>/`) | Authoring skill (`packages/pw-managed-agents/skills/<name>/`) |
| --- | --- | --- |
| Who reads it | The model, lazily | The developer's AI coding assistant |
| Where it lives | Uploaded to Anthropic | Copied into `.claude/skills/` |
| Sync command | `bunx pw-managed-agents skills sync` | `bunx pw-managed-agents skills install` |
| Lock file | `skill.lock.json` | None |

| | Managed-agent skill | MCP server |
| --- | --- | --- |
| What it is | Folder of instructions the runtime progressively discloses | Live process exposing typed tools over HTTP / stdio |
| When activated | Lazily, when the model decides it is relevant | Always available in the tool catalog from session start |
| Versioning | Skill folder is named in `skills: ["..."]`; array fully replaced on update | URL + name in `mcp_servers: [...]`; same replacement semantics |
| Example | "How this codebase thinks about review checklists" | "Query the internal search service for related PRs" |

A single agent can have both. Pick the surface that matches the capability shape before authoring.

## Phase 1 - Gather Requirements

Ask the developer:

- **Durable instructions vs external state?** Stable multi-step instructions reusable across sessions -> Skill. Read or write external state (DB queries, file writes, HTTP calls) -> MCP.
- **Which existing MCP servers are in play?** Each gets one entry in `mcp_servers`. Record its URL (and the env var the deployment uses for prod, if dev points at localhost).
- **Skill naming.** The directory basename MUST equal the `name:` frontmatter field MUST equal the entry in the agent's `skills` array. Kebab-case. No exceptions; the library's `packageSkill` validator throws otherwise.
- **Local dev vs deployed.** For MCP, plan how the URL varies by environment (env var override is the canonical pattern; see `agent.ts` examples below).
- **Skill body shape.** Anything multi-paragraph, optional, or only relevant in some sessions belongs in a Skill, not in `system`. See `pw-agents-context`.

## Phase 2 - Author

### 2a. Scaffold a managed-agent skill

```bash
bunx pw-managed-agents new skill repo-review-checklist
```

This creates `<skillsDir>/repo-review-checklist/` with a `SKILL.md` stub and a `README.md`. The default `<skillsDir>` is `<agentsDir>/_skills` unless `pw-managed-agents.config.ts` overrides it. The folder basename equals the kebab-case name the developer passed.

Edit `SKILL.md`. Required frontmatter, per the agentskills.io spec and parsed by `core/skills/frontmatter.ts`:

```yaml
---
name: repo-review-checklist
description: One paragraph. What the skill does + when to invoke it. The runtime reads this first; everything else is fetched on demand. Cap at 1024 chars.
allowed-tools: Read, Write, Edit, Bash(bun run:*)
metadata:
  area: code-review
---
```

Optional fields the library's parser recognizes: `license`, `compatibility`, additional `metadata` keys, `allowed-tools` (space-separated string).

Body convention (mirror the phase structure used in this directory):

- Phase 1 - Gather Requirements
- Phase 2 - Do the work (TypeScript snippets when relevant)
- Phase 3 - Verify
- Pitfalls
- References

Keep `SKILL.md` under ~300 lines. Move language-specific reference snippets into `references/<topic>.md` so they only load when the model navigates there. Optional siblings the library zips up alongside `SKILL.md`: `references/*.md` for progressive disclosure, `scripts/*` for executable helpers, `assets/*` for static files.

### 2b. Upload via `syncSkill`

```bash
bunx pw-managed-agents skills sync
```

This walks every `<skillsDir>/<name>/SKILL.md`, calls `packageSkill` (zips the folder, computes a stable content hash), and then `syncSkill` (from `core/skills/sync.ts`). Behavior:

- **Lock file content hash matches the freshly-computed one** -> short-circuit with `{ action: "noop" }`. No upload, no version bump.
- **Missing lock + no skill found by `display_title`** -> `beta.skills.create({ display_title, files: [zip] })`. Write the lock.
- **Lock present, or skill matched by `display_title`** -> `beta.skills.versions.create(skillId, { files: [zip] })`. Rewrite the lock with the new version id.

Sync one skill instead of all:

```bash
bunx pw-managed-agents skills sync repo-review-checklist
```

Skills gate new identities the same way agents do: once a skill has locks for
other targets, syncing a target with no lock refuses (a mistyped `--target`
looks exactly like this) and requires `--new-target` to confirm a genuinely new
destination. Do not work around the refusal by deleting a lock - that orphans
the published id it recorded.

The lock file lives at `<skillsDir>/<name>/skill.lock.json` for the `default` deploy target, and `skill.<target>.lock.json` for a named one (`--target staging`). Derive the path with `skillLockPath(dirPath, target)`:

```json
{
  "id": "sk_...",
  "latestVersion": "skv_...",
  "displayTitle": "repo-review-checklist",
  "contentHash": "a1b2c3...",
  "updated_at": "2026-05-14T12:00:00.000Z",
  "target": { "name": "default", "mode": "api-key" }
}
```

Commit it. The content hash drives the no-op short-circuit, which is the meaningful improvement over uploading on every CI run.

For programmatic uploads outside the CLI:

```typescript
import {
  defineSkill,
  resolveTargetName,
  skillLockPath,
  syncSkill,
} from "@pressw-llc/managed-agents";

const directoryPath = "./agents/_skills/repo-review-checklist";
const skill = defineSkill({ directoryPath });
const target = resolveTargetName();

const result = await syncSkill(skill, skillLockPath(directoryPath, target), {
  target,
});
console.log(result.action, result.lock.id, result.lock.latestVersion);
```

Derive the path with `skillLockPath` rather than hardcoding `skill.lock.json`: a literal path publishes every target into the `default` target's lock, which is the collision this keying exists to prevent.

### 2c. Attach skills + MCP servers in `agent.ts`

```typescript
import { defineAgent } from "@pressw-llc/managed-agents";

const REPO_MCP_URL = process.env.REPO_MCP_URL ?? "http://localhost:8080/mcp";

export const definition = defineAgent({
  name: "Code Reviewer",
  model: "claude-sonnet-4-6",
  system: "You review PRs using the repo MCP tools and the project's review checklist.",
  tools: [{ type: "agent_toolset_20260401" }],
  mcp_servers: [
    { type: "url", name: "repo-mcp", url: REPO_MCP_URL },
  ],
  skills: [
    "repo-review-checklist",
    "team-conventions",
  ],
  metadata: {
    repo_path: "agents/code-reviewer",
  },
});
```

`skills` entries reference uploaded skill names; the runtime resolves them at session start by matching the agentskills.io `name:` field. If a name in `skills` does not match an uploaded skill, the entry is silently ignored at runtime - no obvious error surfaces.

`mcp_servers[]` accepts the SDK's MCP entry shape - the `{ type: "url", name, url }` variant is the common one. For stdio MCP servers, see the SDK type definitions and re-fetch the live docs before guessing the shape.

### 2d. Project layout

```
agents/
  code-reviewer/
    agent.ts
    sync.ts
    run.ts
    agent.lock.json
  _skills/
    repo-review-checklist/
      SKILL.md
      references/
        review-priorities.md
      skill.lock.json
    team-conventions/
      SKILL.md
      skill.lock.json
```

The `_skills/` underscore prefix is what `walkSkills` uses to keep the skills directory distinct from agent directories; the discover helpers skip any folder starting with `_` so the same parent can hold both.

## Phase 3 - Verify

### Confirm the upload landed

```bash
bunx pw-managed-agents list
```

The local managed-agent skills section prints `<name> <displayTitle>` for every folder containing a `SKILL.md`. The remote sessions block does not show skills (skills are tied to agents, not sessions), so cross-check via the SDK:

```typescript
import { createClient } from "@pressw-llc/managed-agents";

const client = await createClient();
const page = client.sdk.beta.skills.list({ source: "custom" });
for await (const s of page) {
  console.log(`${s.display_title} ${s.id} v=${s.latest_version}`);
}
```

> Listing custom skills uses `client.sdk.beta.skills.list({ source: "custom" })` directly because the library does not wrap the read surface. This is the supported escape hatch.

### Confirm the agent references it

`bunx pw-managed-agents sync <agent-name>` re-publishes the agent with the current `skills` array. Inspect the canonical record after:

```typescript
import { readAgentLock, retrieveAgent } from "@pressw-llc/managed-agents";

const lock = readAgentLock("./agents/code-reviewer/agent.lock.json");
if (!lock) throw new Error("sync the agent first");

const agent = await retrieveAgent(lock.id);
console.log("skills:", agent.skills);
console.log("mcp_servers:", agent.mcp_servers?.map((s) => s.name));
```

The `skills` array should match what `agent.ts` declares. If an entry is missing, the most likely cause is a name typo against the folder basename.

### Smoke-test the runtime

```bash
bunx pw-managed-agents run code-reviewer -m "Apply the review checklist to this diff."
```

A first model turn that references skill content or issues a tool call against the MCP server confirms both surfaces resolved. If the MCP tools are absent from the tool catalog, the most likely cause is that the URL is unreachable from the env's network (a `localhost:8080` URL only works if the env can hit the host's loopback - in practice that means an ngrok-style tunnel or a deployed MCP).

## Pitfalls

- **`skills` and `mcp_servers` are fully replaced on update.** Like other array fields on an agent, sending one entry replaces the lot. Always derive these arrays from the `definition` constant in `agent.ts` so partial updates do not happen by accident.
- **Skill `name` must equal the folder basename.** The library's `packageSkill` validator throws on mismatch (and the agentskills.io contract requires it). `<skillsDir>/foo/SKILL.md` must declare `name: foo`.
- **Lock-file content-hash short-circuit.** `syncSkill` packages the folder, hashes the bundle, and short-circuits with `{ action: "noop" }` if the hash matches the lock. This is intentional - the library does not upload on every CI run. To force a new version (rare; usually wanted when an upload silently failed), delete the lock and re-sync.
- **The target check runs before that short-circuit.** A skill id only exists inside the workspace that issued it, so `syncSkill` compares the lock's recorded target against the authenticated client first and throws `LockTargetMismatchError` on a disagreement. Were the order reversed, an unchanged bundle read against the wrong target would return a foreign id without ever calling the API.
- **MCP server URL changes require an agent version bump.** Any change to `mcp_servers[].url` flows through `agents.update` and produces a new version. Plan rollouts so the URL is reachable from the env before publishing.
- **Local MCP servers need a reachable host.** A managed-agent env's network is not your laptop's loopback. Use a public URL (ngrok / Cloudflare tunnel / a deployed dev instance) when smoke-testing locally.
- **Skill description weight matters.** The runtime materializes skill `description` + frontmatter eagerly. Keep `description` short and push long content into phased body sections and `references/*.md` so cold-start tokens stay small.
- **Custom (non-MCP) tools go in `tools`, not `mcp_servers`.** If a future build inlines a tool definition directly into the agent config, that belongs in the `tools` array. MCP is for tool surfaces hosted as separate processes.
- **Authoring skills and managed-agent skills are different things.** The skills under `<skillsDir>/` are the ones the runtime resolves; the skills under `packages/pw-managed-agents/skills/` (or the consumer's `.claude/skills/` after `skills install`) are documentation for the AI coding assistant.
- **The library does not yet wrap `skills.list` / `versions.list`.** Read those through `client.sdk.beta.skills.*` directly. Inspection helpers may land later; the bytes-in / bytes-out contract for `defineSkill` + `syncSkill` is stable today.

## References

- /docs/en/managed-agents/skills - https://platform.claude.com/docs/en/managed-agents/skills (runtime skill resolution)
- /docs/en/managed-agents/mcp-connector - https://platform.claude.com/docs/en/managed-agents/mcp-connector (MCP entry shape, transports)
- /docs/en/managed-agents/tools - https://platform.claude.com/docs/en/managed-agents/tools (how MCP / custom / first-party tools cohabit)
- /docs/en/managed-agents/agent-setup - https://platform.claude.com/docs/en/managed-agents/agent-setup
- https://agentskills.io - frontmatter contract (required `name`, `description`; optional `license`, `compatibility`, `metadata`, `allowed-tools`)
- `packages/pw-managed-agents/src/core/skills/` - `defineSkill`, `syncSkill`, `packageSkill`, `parseFrontmatter`, lock helpers
- Related skills: `pw-agents-create-agent`, `pw-agents-context`, `pw-agents-sessions`
