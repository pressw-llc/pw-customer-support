# Authoring skills

This directory ships **authoring skills** that guide an AI coding assistant (Claude Code, Cursor, or any tool that loads the [agentskills.io](https://agentskills.io) format) when a developer is using `@pressw-llc/pipeline` inside their project. Each subfolder contains a `SKILL.md` (and optional `references/` companions) that the assistant progressively discloses based on developer intent. The skills are documentation; they do not run code themselves.

## Install into a consumer project

```bash
bunx pw-pipeline skills install
```

This copies the entire tree into `./.claude/skills/`. The Claude Code / Cursor agent then loads each `SKILL.md` lazily when the developer's request matches the skill's `description:` field. Pass `--force` to overwrite an existing install, or `--destination <path>` to target a different directory.

## What's in this directory

| Folder | Topic |
| --- | --- |
| `pw-pipeline-overview/` | Entry-point routing skill. Routes the assistant to the right sibling based on developer intent. |
| `pw-pipeline-define-pipeline/` | `definePipeline`, graph nodes, triggers, terminal flags, composition. |
| `pw-pipeline-define-step/` | `defineStep`, Zod schemas, `StepContext` surfaces. |
| `pw-pipeline-agent-steps/` | `defineAgentStep` and wiring `@pressw-llc/managed-agents` via `agentSessionFactory`. |
| `pw-pipeline-lambda/` | `lambdaHandlerFor` structured / N:M / registry forms and discovery rules. |
| `pw-pipeline-fargate/` | `fargateMain`, `configureFargateRuntime`, long-poll SQS, credential refresh. |
| `pw-pipeline-parallel/` | Parallel fan-out + join, `priorOutputs`, persistence invariants. |
| `pw-pipeline-persistence/` | Postgres schema, migrations, repo gotchas. |
| `pw-pipeline-validate/` | `pw-pipeline validate` checks and CI integration. |
| `pw-pipeline-local-dev/` | Docker Compose infra, LocalStack SQS, live examples. |

## Composing with `@pressw-llc/managed-agents`

Agent steps call out to Anthropic Managed Agents through an injected `agentSessionFactory`. The pipeline package does not import `@pressw-llc/managed-agents`; the consumer wires `runOneShot` (or lower-level session APIs) at cold-start. See `pw-pipeline-agent-steps` and install managed-agent authoring skills with `bunx pw-managed-agents skills install` when both libraries are in play.
