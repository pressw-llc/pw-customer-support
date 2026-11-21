---
name: pw-agents-multiagent
description: Define and operate a multiagent coordinator that delegates to a roster of specialist agents inside a single session, using `defineCoordinator + listThreads + streamThread + interruptThread + archiveThread + routeToolConfirmation` from `@pressw-llc/managed-agents`. Load when authoring a coordinator agent definition, when observing primary-thread vs child-thread events, when routing cross-thread tool confirmations or custom-tool results back to the originating child, or when managing the thread lifecycle (spawn, interrupt, archive) under the roster + concurrent-thread caps the library enforces at definition time.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-managed-agents:*)
metadata:
  area: pw-managed-agents
  api-beta: managed-agents-2026-04-01
---

# Multiagent coordinators

Coordinator agents delegate to a roster of specialist agents inside a single session. The coordinator runs in the **primary thread** (also the session-level event stream); each delegated specialist runs in its own **session thread**, context-isolated but sharing the env's filesystem.

The library enforces the live caps at definition time via `defineCoordinator`:

- `MULTIAGENT_MAX_ROSTER = 20` unique entries in `multiagent.agents` (uniqueness, not concurrency).
- `MULTIAGENT_MAX_CONCURRENT_THREADS = 25` concurrent threads per session (including the primary).
- `MULTIAGENT_MAX_DEPTH = 1` - a specialist invoked through a coordinator has its own `multiagent` config ignored.

These constants are re-exported from the package for documentation and assertion.

## Phase 1 - Gather Requirements

Decide before writing config:

- **Coordinator role** - what high-level task does it own (engineering lead, research triager, QA orchestrator)? Its `system` prompt explains when to delegate vs answer directly.
- **Specialist roster** - which agents will it delegate to, by id? Max 20 unique. The coordinator can call multiple copies of the same agent at runtime.
- **Pinning** - prod coordinators should pin specialists to a specific `version` so upstream agent updates do not silently change behavior.
- **Self-recursion** - if the coordinator should be able to call copies of itself, include `{ type: "self" }`.
- **Concurrency** - fan-out beyond 25 threads requires serial batching or aggressive archive between waves.

If specialist agents do not exist yet, scaffold them first via `pw-agents-create-agent`. If the env does not exist yet, run `pw-agents-environments`.

## Phase 2 - Author the Coordinator

`defineCoordinator` is a typed wrapper around `defineAgent` that enforces the roster cap and that `multiagent.type === "coordinator"`. Put it in `agents/<coordinator-name>/agent.ts`:

```typescript
import { fileURLToPath } from "node:url";
import { defineCoordinator, readAgentLock } from "@pressw-llc/managed-agents";

const reviewerLock = readAgentLock(
  fileURLToPath(new URL("../code-reviewer/agent.lock.json", import.meta.url)),
);
const testerLock = readAgentLock(
  fileURLToPath(new URL("../test-writer/agent.lock.json", import.meta.url)),
);
if (!reviewerLock || !testerLock) {
  throw new Error("publish the specialist agents before defining the coordinator");
}

export const definition = defineCoordinator({
  name: "Engineering Lead",
  model: "claude-opus-4-7",
  system: [
    "You coordinate engineering work.",
    "Delegate code review to the reviewer agent and test writing to the test-writer agent.",
    "Decide which specialist to call before issuing tool calls of your own.",
  ].join(" "),
  tools: [{ type: "agent_toolset_20260401" }],
  multiagent: {
    type: "coordinator",
    agents: [
      { type: "agent", id: reviewerLock.id },
      { type: "agent", id: testerLock.id, version: testerLock.version },
      { type: "self" },
    ],
  },
  metadata: {
    repo_path: "agents/engineering-lead",
  },
});
```

Roster entry shapes (from `core/multiagent/types.ts` and the SDK params union):

| Shape | Meaning |
| --- | --- |
| `{ type: "agent", id }` | Reference an existing agent. Floats to the latest version at coordinator-create time. |
| `{ type: "agent", id, version }` | Pin a specific version. Recommended for prod. |
| `{ type: "self" }` | Allow the coordinator to spawn copies of itself. |

Read locks for specialist ids at the top of the file. Hardcoding string ids works but couples the coordinator to a specific publish, while a pinned `{ id, version }` from a sibling lock file gives the developer a deliberate roll-forward step (re-sync the specialist, commit the lock, re-sync the coordinator).

Publish the coordinator like any other agent:

```bash
bunx pw-managed-agents sync engineering-lead
```

The CLI runs `syncAgent` against the definition, which validates the multiagent block via the SDK params type. The library's caps are advisory: `defineCoordinator` throws synchronously when the roster exceeds 20 entries; concurrent-thread and depth caps are enforced by the server.

## Phase 3 - Drive the Coordinator

Start a session against the coordinator. The session-level event stream is the primary thread; it carries the coordinator's reasoning plus condensed activity from each delegated specialist.

```typescript
import {
  createSession,
  isEventType,
  listThreads,
  readAgentLock,
  sendUserMessage,
  streamSession,
  type SessionEvent,
} from "@pressw-llc/managed-agents";

const lock = readAgentLock("./agents/engineering-lead/agent.lock.json");
if (!lock) throw new Error("sync the coordinator first");

const session = await createSession({
  agent: lock.id,
  environment_id: envId,
});

const stream = await streamSession(session.id);
await sendUserMessage(session.id, "Review PR #42 and add the missing tests.");

for await (const event of stream as AsyncIterable<SessionEvent>) {
  if (isEventType(event, "session.thread_created")) {
    console.log(`spawned thread: ${event.session_thread_id}`);
  } else if (isEventType(event, "session.thread_status_running")) {
    console.log(`thread running: ${event.session_thread_id}`);
  } else if (isEventType(event, "session.thread_status_idle")) {
    const c = event as unknown as { parent_thread_id?: string | null };
    if (c.parent_thread_id) continue;
    break;
  } else if (isEventType(event, "session.thread_status_terminated")) {
    throw new Error("session terminated");
  }
}
```

Sub-thread idles (`parent_thread_id` set) are intermediate. The terminal signal is the primary thread idling (`parent_thread_id` null or missing). See `references/event-types.md` for the full event catalogue.

## Phase 4 - Drill Into a Specialist

The primary thread shows condensed activity. For a specialist's full reasoning plus tool calls, list threads and stream the one of interest:

```typescript
import { listThreads, streamThread } from "@pressw-llc/managed-agents";

const threads = await listThreads(session.id);
for (const t of threads) {
  console.log(`[${t.agentName}] ${t.status} parent=${t.parent_thread_id ?? "primary"}`);
}

const child = threads.find((t) => t.agentName === "code-reviewer" && t.parent_thread_id);
if (!child) throw new Error("no reviewer thread spawned yet");

const childStream = await streamThread(child.id, { sessionId: session.id });
for await (const event of childStream) {
  if (event.type === "agent.message") {
    for (const block of event.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  } else if (event.type === "session.thread_status_idle") {
    break;
  }
}
```

`parent_thread_id` is null for the primary thread - use it as the discriminator when filtering listings.

## Phase 5 - Lifecycle Operations

### Interrupt a specific thread

```typescript
import { interruptThread } from "@pressw-llc/managed-agents";

await interruptThread(session.id, child.id);
```

Semantics per `core/multiagent/threads.ts`:

- Against a `requires_action` child, marks each pending tool call denied and re-emits `session.thread_status_idle` with `stop_reason.type === "end_turn"`. The model is **not** resampled.
- Against an `idle` child, no-op.
- Against a `running` child, cancels the current model turn.

To interrupt the primary thread (the session-level loop) use `sendInterrupt(session.id)` without `sessionThreadId` - see `pw-agents-sessions`.

### Archive a thread

```typescript
import { archiveThread } from "@pressw-llc/managed-agents";

await archiveThread(child.id, { sessionId: session.id });
```

Archiving frees a slot against the 25-thread cap. Archive succeeds only if the thread is `idle`; for running or `requires_action` threads, interrupt first, then archive.

### Resume a persistent thread

Threads are durable. A specialist thread retains its conversation history; the coordinator (or you, via primary-thread events) can resume it. Carry the thread id from `listThreads` across runs if cross-session resumption is part of the workflow.

## Phase 6 - Cross-Thread Tool Confirmation

When a non-coordinator agent blocks on `requires_action` (an `always_ask` tool, an `mcp` confirmation, or a custom tool result), the blocking event is **cross-posted to the primary thread** with `session_thread_id` identifying the originating child:

```json
{
  "type": "session.thread_status_idle",
  "session_thread_id": "sth_01DEF...",
  "agent_name": "code-reviewer",
  "stop_reason": {
    "type": "requires_action",
    "event_ids": ["toolu_01XYZ..."]
  }
}
```

Reply via `routeToolConfirmation` - the server routes the reply back to the originating child thread by `tool_use_id` / `custom_tool_use_id`. The reply itself does not need `session_thread_id`:

```typescript
import { routeToolConfirmation } from "@pressw-llc/managed-agents";

const stop = event.stop_reason as { type: string; event_ids: string[] };
if (stop.type === "requires_action") {
  for (const eventId of stop.event_ids) {
    await routeToolConfirmation(session.id, {
      kind: "confirm",
      toolUseId: eventId,
      result: "allow",
    });
  }
}
```

For custom tools the client implements, swap to the `custom_result` variant:

```typescript
await routeToolConfirmation(session.id, {
  kind: "custom_result",
  customToolUseId: customId,
  content: [{ type: "text", text: JSON.stringify(result) }],
});
```

## Verify

After driving the coordinator, confirm the lifecycle landed cleanly:

- `listThreads(sessionId)` shows the primary thread plus every spawned child. Status reads `idle` for completed threads, `terminated` for archived / errored ones.
- Each child's `parent_thread_id` points at the primary thread; the primary's is null.
- The primary thread idled with `stop_reason.type === "end_turn"`. `requires_action` on the primary means the developer's cross-thread routing missed an event id; `max_tokens` means the coordinator hit the budget across the fan-out.

## Pitfalls

- **Depth is 1.** A coordinator can only delegate one level deep; nested coordinator configs on specialists are ignored. Design rosters flat.
- **20-agent roster cap.** The library throws synchronously when `multiagent.agents.length > 20`. The cap is on uniqueness, not concurrency - the coordinator can spawn multiple copies of the same entry.
- **25 concurrent thread cap, including the primary.** Archive idle threads aggressively if fan-out is wide.
- **Filesystem is shared; tools and context are not.** Only the env filesystem is shared between coordinator and specialists. If two threads need non-filesystem coordination, persist to disk or route through the coordinator.
- **The primary thread is condensed.** Start / end / blocking events from specialists, not full reasoning. Drill into the child thread for the complete trace.
- **Archive requires idle.** Running or `requires_action` threads must be interrupted first; otherwise archive fails.
- **`parent_thread_id` is null for the primary thread.** Use it when filtering listings - the primary shows up alongside children in `listThreads`.
- **Cross-thread tool confirmation does not need `session_thread_id` on the reply.** The server routes by `tool_use_id` / `custom_tool_use_id`. Sending `session_thread_id` is harmless but unnecessary.
- **`{ type: "self" }` is a footgun.** It allows self-recursion at depth 1 - one slot against the 25-thread cap per spawned copy. Pin explicit stop conditions in the coordinator's `system`, or you saturate the thread budget.
- **Pin specialist versions in prod.** Floating `{ type: "agent", id }` entries pick up specialist re-syncs silently. Capture `{ id, version }` from the specialist's lock file so a coordinator roll-forward is a deliberate `bunx pw-managed-agents sync` step.

## References

- /docs/en/managed-agents/multi-agent - https://platform.claude.com/docs/en/managed-agents/multi-agent
- /docs/en/managed-agents/events-and-streaming - https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- /docs/en/managed-agents/agent-setup - https://platform.claude.com/docs/en/managed-agents/agent-setup
- `packages/pw-managed-agents/src/core/multiagent/` - `defineCoordinator`, `listThreads`, `streamThread`, `interruptThread`, `archiveThread`, `routeToolConfirmation`, plus the cap constants
- `references/event-types.md` - companion catalogue of primary-thread vs session-thread event types
- Related skills: `pw-agents-create-agent`, `pw-agents-sessions`, `pw-agents-environments`
