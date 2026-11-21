---
name: pw-agents-overview
description: Entry-point routing skill for `@pressw-llc/managed-agents`. Load first when a developer mentions defining, syncing, running, or operating an Anthropic Managed Agent through this library; when they install the package with `bun add @pressw-llc/managed-agents`; when they reference the `pw-managed-agents` CLI binary; or when they cite an `agents/<name>/` directory or `pw-managed-agents.config.ts`. Routes to the right sibling `pw-agents-*` skill based on developer intent (auth, context, scaffolding, sessions, environments, files, runtime Skills + MCP, multiagent coordinators) and gates the rest on `pw-agents-auth` as the prerequisite.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-managed-agents:*)
metadata:
  area: pw-managed-agents
  api-beta: managed-agents-2026-04-01
---

# `@pressw-llc/managed-agents` - overview

`@pressw-llc/managed-agents` is a typed library plus CLI for defining, syncing, running, and operating Anthropic Managed Agents from any TypeScript project. It wraps `@anthropic-ai/sdk` and `@anthropic-ai/aws-sdk` behind a single `createClient()` that auto-detects whether to use Claude Platform on AWS (SigV4) or the first-party Anthropic API. The library exposes idempotent helpers (`syncAgent`, `syncSkill`) backed by lock files, ergonomic session runners (`runOneShot`, `runMultiTurn`), and a generator-driven CLI (`bunx pw-managed-agents`).

These skills are documentation for the AI coding assistant working inside a project that uses the library. Load `pw-agents-auth` once at the start of any session that will hit the API. Then route to the topic-specific skill below.

## When to load which skill

| Developer intent | Skill |
| --- | --- |
| "I'm setting up credentials / `doctor` is failing / what's the auth mode?" | `pw-agents-auth` |
| "Where do I put the system prompt / metadata / description / how-to instructions?" | `pw-agents-context` |
| "Create a new agent / scaffold `agents/<name>/` / `bunx pw-managed-agents new agent` / `sync` is failing" | `pw-agents-create-agent` |
| "Run an agent end to end / call `runOneShot` / handle a `requires_action` / drive a chat loop" | `pw-agents-sessions` |
| "Create an environment / reuse a sandbox across runs / archive an orphan env" | `pw-agents-environments` |
| "Upload inputs / download artifacts / `/workspace/inputs/*` path conventions" | `pw-agents-files` |
| "Author a managed-agent Skill / `bunx pw-managed-agents skills sync` / attach an MCP server to `agent.ts`" | `pw-agents-managed-agent-skills` |
| "Define a coordinator / fan out to specialists / route cross-thread tool confirmations" | `pw-agents-multiagent` |

The skill names map 1:1 to the folder names under `.claude/skills/` after `bunx pw-managed-agents skills install` (or `packages/pw-managed-agents/skills/` if the developer cloned this repo).

## Quick start

```bash
bun add @pressw-llc/managed-agents

bunx pw-managed-agents init
bunx pw-managed-agents new agent greeter
bunx pw-managed-agents sync greeter
bunx pw-managed-agents run greeter -m "Introduce yourself."
```

The flow above:

1. `init` writes `pw-managed-agents.config.ts` at the project root and creates the agents directory (`./agents/` by default, or `./src/agents/` when `src/` exists).
2. `new agent greeter` scaffolds `agents/greeter/` with `agent.ts`, `sync.ts`, `run.ts`, and a README.
3. `sync` publishes the agent idempotently and writes `agents/greeter/agent.lock.json`. Commit the lock.
4. `run` is a one-shot session against an ephemeral environment using `runOneShot`.

See `pw-agents-create-agent` for the agent module shape and the sync flow, and `pw-agents-sessions` for what `run` does under the hood.

## Project layout

```
pw-managed-agents.config.ts        defineConfig({ agentsDir, agentDefaults, ... })
agents/
  greeter/
    agent.ts                       defineAgent({ name, model, system, ... })
    sync.ts                        syncAgent(definition, lockPath)
    run.ts                         runOneShot({ agent, prompt, ... })
    agent.lock.json                committed; one lock per deploy target
    agent.prod.lock.json           `--target prod`
  _skills/                         managed-agent Skills uploaded to Anthropic
    repo-review-checklist/
      SKILL.md
      skill.lock.json              committed
.claude/skills/                    authoring skills copied via `bunx pw-managed-agents skills install`
```

`agentsDir` defaults to `./agents` (or `./src/agents` when `src/` exists). `skillsDir` defaults to `<agentsDir>/_skills`. Both are overridable in `pw-managed-agents.config.ts`.

Ids are only meaningful inside the workspace that issued them, so locks are keyed by deploy target: `--target` / `PW_AGENTS_TARGET` / config `target`, defaulting to `default` (which keeps the unsuffixed filenames). A sync whose lock records a different target refuses rather than publishing a foreign id. See `pw-agents-create-agent`.

## Prerequisite: `pw-agents-auth`

Every skill in this directory other than `pw-agents-context` assumes the SDK client `createClient()` stands up. Load `pw-agents-auth` once at the start of any session that will publish, run, or list. The library auto-detects between Claude Platform on AWS (SigV4) and the first-party Anthropic API (`ANTHROPIC_API_KEY`, optionally via AWS Secrets Manager). `bunx pw-managed-agents doctor` surfaces missing env before the first API call.

## CLI command reference

```
pw-managed-agents init                        write pw-managed-agents.config.ts + create agents dir
pw-managed-agents doctor                      diagnose env + auth + project config
pw-managed-agents new agent <name>            scaffold an agent folder
pw-managed-agents new skill <name>            scaffold a managed-agent skill folder
pw-managed-agents skills install              copy these authoring skills into ./.claude/skills/
pw-managed-agents sync [agent-name] [--target <t>] [--new-target]  sync one or all agents
pw-managed-agents skills sync [skill-name] [--target <t>] [--new-target]  sync one or all managed-agent skills
pw-managed-agents run <agent-name> [-m "..."] [--target <t>] one-shot run of an agent
pw-managed-agents list                        list local agents + recent remote sessions
```

`init`, `new`, and `skills install` are offline. `doctor`, `sync`, `run`, and `list` lazily instantiate the SDK client.

## References

- Package `README.md` for the canonical quick start
- `packages/pw-managed-agents/src/index.ts` for the public re-exports
- /docs/en/managed-agents/agent-setup - https://platform.claude.com/docs/en/managed-agents/agent-setup
- /docs/en/managed-agents/multi-agent - https://platform.claude.com/docs/en/managed-agents/multi-agent
- Sibling skills: `pw-agents-auth`, `pw-agents-context`, `pw-agents-create-agent`, `pw-agents-sessions`, `pw-agents-environments`, `pw-agents-files`, `pw-agents-managed-agent-skills`, `pw-agents-multiagent`
