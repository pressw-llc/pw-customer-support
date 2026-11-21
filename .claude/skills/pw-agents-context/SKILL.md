---
name: pw-agents-context
description: Decide where each piece of context belongs on an `@pressw-llc/managed-agents` agent definition - `system` prompt, `description`, `metadata`, attached Skills, or the first user event. Load when authoring or revising the `system / description / metadata / skills` fields on a `defineAgent({ ... })` call, when reviewing whether a fact should live at the agent level (durable, every session) vs in a Skill (lazily disclosed how-to) vs in the kickoff user message (this-task-only). Codifies the replace / merge / clear semantics so updates don't silently wipe prior context.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-managed-agents:*)
metadata:
  area: pw-managed-agents
  api-beta: managed-agents-2026-04-01
---

# Context placement for managed agents

Four places hold context for a managed agent. Putting context in the wrong place is the highest-leverage authoring mistake to avoid - each one has different visibility, different replace / merge / clear semantics, and a different cost shape.

| Place | Who sees it | When set | Replace / merge on update |
| --- | --- | --- | --- |
| `system` | Model, every turn | Agent definition | Replaced wholesale; pass `null` to clear |
| `description` | Humans (dashboards / `list` UIs), not the model | Agent definition | Replaced wholesale; pass empty string to clear |
| `metadata` | Client code only, never the model | Agent definition | Merged per key; set a value to `""` to delete that key |
| Skills | Model, lazily | Agent definition (`skills` array) | Array fully replaced on update |
| First `user.message` | Model, that session only | `sessions.events.send` (or `runOneShot` `prompt`) | Per-session, not part of the agent definition |

When in doubt walk the table top to bottom. "Does every session need this?" -> not in the user message. "Does the model need to read it?" -> not in `metadata` or `description`. "Is it a stable persona / role?" -> `system`. "Is it durable how-to instructions?" -> Skill.

## Phase 1 - Gather Requirements

For each piece of candidate context the developer wants to add, ask:

- **Who needs to read it?** The model, the dashboard, both, neither.
- **How often does it change?** Per session (kickoff message), per release (agent update), never (immutable identifier in `metadata`).
- **Is it secret or PII?** If so, do not put it in `metadata` (logged), do not put it in `system` (echoed in outputs). Pass via session-level events with short-lived scoping, or store outside the agent definition entirely.
- **Stable instruction or task-specific?** Stable -> `system` if short, a Skill if long. Task-specific -> the first user event.

Common buckets and their canonical home:

- Persona / role / tone -> `system`.
- Long, optional how-to (review checklist, domain math, repo conventions) -> Skill, see `pw-agents-managed-agent-skills`.
- Owner tag, repo pointer, cost-center -> `metadata`.
- Human-readable label for the dashboard -> `description`.
- "Review PR #1234 today" -> first user event when the session is created.

## Phase 2 - Author

### 2a. `system` - the persona contract

`system` is the contract between the developer and the model. Edit it like a contract: rarely, deliberately, only when the role itself changes.

```typescript
import { defineAgent } from "@pressw-llc/managed-agents";

export const definition = defineAgent({
  name: "code-reviewer",
  model: "claude-sonnet-4-6",
  system: [
    "You are a senior code reviewer for this codebase.",
    "Prioritize security and correctness over style.",
    "When you need durable how-to knowledge (review checklists, repo conventions),",
    "consult the attached skills rather than improvising.",
    "When you need to read code or run tools, prefer MCP tools over guessing.",
  ].join(" "),
  description: "Reviews PRs against project conventions.",
  tools: [{ type: "agent_toolset_20260401" }],
  metadata: {
    owner: "platform",
    repo_path: "agents/code-reviewer",
  },
  skills: ["repo-review-checklist"],
});
```

Rules of thumb for `system`:

- Keep it short. Long stable instructions belong in a Skill.
- No secrets, no PII. The model sees `system` every turn and may surface it in outputs.
- Reference attached Skills explicitly so the model knows what to consult.

### 2b. `metadata` - client-side tracking

`metadata` is `Record<string, string>`. The model does not see it. Good uses:

- `owner`, `repo_path`, `cost_center`-style tags for dashboards and observability.
- A back-pointer to the source of truth in this repo (`repo_path: agents/code-reviewer`) so an operator can map an agent id back to a git directory.

Bad uses:

- Anything the model needs to read - the model will not see it.
- Secrets - assume metadata flows into log pipelines and dashboards.
- Per-session task data - that belongs in the kickoff user message.

### 2c. Skills - durable how-to

Anything that is multi-paragraph, optional, or only relevant in some sessions belongs in a Skill rather than `system`. The runtime progressively discloses skill bodies, so a long checklist costs almost no cold-start tokens until the model actually navigates into it.

See `pw-agents-managed-agent-skills` for the upload contract and `defineSkill` / `syncSkill`. From a context-placement view: the `skills` array on the agent is a list of skill names (kebab-case, equal to the folder basename) the runtime resolves at session start.

### 2d. First user event - the task

Per-session instructions live in the kickoff `user.message`, not on the agent definition. The library wraps this for the 90% case:

```typescript
import { readAgentLock, runOneShot } from "@pressw-llc/managed-agents";

const lock = readAgentLock("./agents/code-reviewer/agent.lock.json");
if (!lock) throw new Error("run `bunx pw-managed-agents sync code-reviewer` first");

const result = await runOneShot({
  agent: lock.id,
  prompt: [
    "Review PR #1234.",
    "Focus on the changes under packages/auth/.",
    "Flag anything that bypasses the security validators in shared/utils.ts.",
  ].join(" "),
  environment: { create: true },
});
```

`prompt` becomes the kickoff `user.message`. If this text drifts into `system`, every session created against the agent inherits it - almost never what the developer wants. Reach for `runMultiTurn` instead of `runOneShot` if follow-ups are needed; `pw-agents-sessions` covers the lower-level event surface for fully custom drivers.

## Phase 3 - Verify

After `bunx pw-managed-agents sync <name>` and a smoke run, confirm what the API stored matches the source of truth in `agent.ts`:

```typescript
import { readAgentLock, retrieveAgent } from "@pressw-llc/managed-agents";

const lock = readAgentLock("./agents/code-reviewer/agent.lock.json");
if (!lock) throw new Error("not synced yet");

const agent = await retrieveAgent(lock.id);
console.log("system head:", typeof agent.system === "string" ? agent.system.slice(0, 200) : agent.system);
console.log("description:", agent.description);
console.log("metadata keys:", Object.keys(agent.metadata ?? {}));
console.log("skills:", agent.skills);
```

Checklist:

- `system` matches what `agent.ts` declares - no manual API edits drifted in.
- `description` is a humans-only one-liner.
- `metadata` keys are stable identifiers, no PII / no per-session task text.
- `skills` lists exactly the skill names the developer expects; missing entries usually mean a name typo against the folder basename.

## Pitfalls

- **`system` is replaced on update, not merged.** Sending `{ version, system: "new persona" }` discards the old persona entirely. To clear `system` so the model has no instruction, pass `null`. To append rather than replace, include the full new string yourself - the API will not stitch two values together.
- **`metadata` merges per key.** Setting `{ metadata: { owner: "x" } }` leaves all other keys untouched. To delete a key, set its value to `""`. To wipe metadata, set every existing key to `""`.
- **`description` is replaceable / clearable too.** Pass an empty string on update to clear it; omit the field to leave it alone.
- **`skills` and `mcp_servers` are fully replaced on update.** Like other array fields, sending one entry replaces the lot. Always derive these arrays from the `definition` constant in `agent.ts` so partial updates can not happen by accident.
- **Conversation memory is per-session, not per-agent.** History persists within a session thread (the agent remembers earlier turns), but it does not survive across sessions. For cross-session memory, the agent must read and write files in its environment - see `pw-agents-files`.
- **Skill content beats `system` content.** A multi-hundred-line `system` is a recipe for prompt drift. Move durable instructions into Skills; keep `system` to the persona-only contract.
- **Don't encode task-specific facts in the agent definition.** "Review PR #1234" in `system` is a footgun: every future session inherits it. Per-task facts go in the kickoff `prompt` / `user.message`.
- **`metadata` and `description` are invisible to the model.** Trying to feed the model context by putting it there silently fails. Use `system` or a Skill.
- **`metadata` is logged.** Treat it like structured log fields - safe to read, no secrets.

## References

- /docs/en/managed-agents/agent-setup - https://platform.claude.com/docs/en/managed-agents/agent-setup (canonical `system` / `description` / `metadata` / `skills` semantics)
- /docs/en/managed-agents/events-and-streaming - https://platform.claude.com/docs/en/managed-agents/events-and-streaming (`user.message` shape)
- /docs/en/managed-agents/environments - https://platform.claude.com/docs/en/managed-agents/environments (where cross-session memory lives)
- /docs/en/managed-agents/files - https://platform.claude.com/docs/en/managed-agents/files (durable file IO for an agent)
- Related skills: `pw-agents-create-agent`, `pw-agents-sessions`, `pw-agents-managed-agent-skills`
