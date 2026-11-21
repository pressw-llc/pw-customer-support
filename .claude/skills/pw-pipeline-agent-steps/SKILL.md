---
name: pw-pipeline-agent-steps
description: Add a managed-agent step with `defineAgentStep` and wire `agentSessionFactory` + `agentIdResolver` at Lambda or Fargate cold-start. Load when a graph step should call Anthropic Managed Agents, when validating agent step shape, when moving an agent step from Lambda to Fargate, or when integrating `@pressw-llc/managed-agents` with the pipeline engine.
allowed-tools: Read, Write, Edit, Bash(bunx pw-pipeline validate:*), Bash(bunx pw-managed-agents:*)
metadata:
  area: pw-pipeline
---

# Agent steps

The pipeline engine never imports `@pressw-llc/managed-agents`. Consumers inject session execution at runtime through `configureLambdaRuntime` / `configureFargateRuntime`.

## defineAgentStep

```typescript
import { defineAgentStep } from "@pressw-llc/pipeline/define";
import { definition as contactResolver } from "@/agents/contact-resolver/agent.js";
import { AgentInput, AgentOutput } from "./schema.js";

export default defineAgentStep({
  agent: { kind: "managed", definition: contactResolver },
  input: AgentInput,
  output: AgentOutput,
  buildPrompt(input) {
    return `Resolve owner of property ${input.targetRecordId}.`;
  },
});
```

Graph node must use `runtime: "fargate"` for managed agents (validator check 5). Lambda's 15-minute cap is insufficient for typical agent sessions.

## Cold-start wiring

```typescript
import {
  readAgentLockForTarget,
  resolveTargetName,
  runOneShot,
} from "@pressw-llc/managed-agents";
import {
  type AgentSessionFactory,
  configureFargateRuntime,
} from "@pressw-llc/pipeline";
import { resolve } from "node:path";

const agentSessionFactory: AgentSessionFactory = async (args) => {
  const result = await runOneShot({
    agent: args.agentId,
    prompt:
      typeof args.prompt === "string"
        ? args.prompt
        : JSON.stringify(args.prompt),
  });
  return {
    textOutput: result.textOutput,
    toolCalls: result.toolCalls,
    sessionId: result.sessionId,
  };
};

configureFargateRuntime({
  agentSessionFactory,
  agentIdResolver: ({ agentName }) => {
    const target = resolveTargetName();
    const lock = readAgentLockForTarget(resolve("agents", agentName), target);
    if (!lock) {
      throw new Error(`agent '${agentName}' is unsynced for target '${target}'`);
    }
    return lock.id;
  },
  sqs: { defaults: true },
  repoFactory: /* ... */,
});
```

- Map `args.agentId` to `runOneShot({ agent })` - the engine resolves the lock id before calling the factory.
- `args.mode` is engine bookkeeping; `runOneShot` does not consume it.
- For long-lived Fargate tasks, wrap credential minting with `createCredentialRefresher` (`pw-pipeline-fargate`).

## Validation

`bunx pw-pipeline validate` check 8 (`invalid-agent-step-shape`) requires:

- `agent.kind === "managed"`
- non-empty `agent.definition.name`
- non-empty system prompt on the definition
- Zod `input` / `output` and `buildPrompt` function

Use `--skip-agent-resolution` in CI when step modules cannot be imported (missing agent lock files).

## End-to-end reference

`examples/property-summary/scripts/demo-live.ts` wires managed agents against live infra.

For agent authoring (sync, sessions, MCP): install `bunx pw-managed-agents skills install` and load `pw-agents-*` skills.

## References

- `pw-pipeline-fargate`, `pw-pipeline-validate`, `pw-pipeline-local-dev`
- Package README section "Defining an agent step"
