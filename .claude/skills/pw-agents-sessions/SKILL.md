---
name: pw-agents-sessions
description: Run a managed agent end-to-end using `@pressw-llc/managed-agents` - one-shot, multi-turn, or fully custom with manual event handling. Load when wiring a session into a script, API handler, eval harness, or chat loop; when deciding between `runOneShot` / `runMultiTurn` and the lower-level `createSession + streamSession + sendUserMessage` path; when handling interrupts, tool confirmations, or multiagent thread-status events. Covers the SSE event loop, the `status_idle` / `thread_status_idle` exit signals, and the archive-on-exit lifecycle.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-managed-agents:*)
metadata:
  area: pw-managed-agents
  api-beta: managed-agents-2026-04-01
---

# Run sessions

Sessions are where the model actually runs. The library exposes three layers - a one-shot helper, a multi-turn helper, and the raw `createSession` + `streamSession` + `sendUserMessage` primitives. Reach for the helpers first; drop down only when the helpers cannot model the driver you need.

## Phase 1 - Gather Requirements

Ask the developer (or read the agent folder under `agents/<name>/`):

- **Agent id** - either the literal id or the value from `readAgentLock(...).id`. If the agent has not been published, run `bunx pw-managed-agents sync <name>` first (see `pw-agents-create-agent`).
- **Environment shape** - ephemeral (default - the helper creates and archives one) or reusable (pass `{ id }`). See `pw-agents-environments`.
- **Initial prompt** - the kickoff text. Becomes the first `user.message` event.
- **Multi-turn vs one-shot** - one user prompt -> reply, or a chat loop with follow-ups?
- **Custom event handling** - does the caller need to observe tool calls, route tool-confirmation replies, drive multiagent sub-threads, or interrupt mid-turn? Those need the low-level path.
- **Cleanup policy** - archive the env / session on exit (the default) or leave them around for inspection?
- **Coordinator?** - if the agent is a multiagent coordinator, also load `pw-agents-multiagent` for the per-thread observation pattern; the helpers ignore sub-thread idles but the low-level loop has to.

## Phase 2 - Author

### 2a. `runOneShot` - one prompt in, full text + tool-call summary out

```typescript
import { readAgentLock, runOneShot } from "@pressw-llc/managed-agents";

const lock = readAgentLock("./agents/code-reviewer/agent.lock.json");
if (!lock) throw new Error("run `bunx pw-managed-agents sync code-reviewer` first");

const result = await runOneShot({
  agent: lock.id,
  prompt: "Review PR #1234. Flag security issues first.",
  environment: { create: true },
});

console.log(result.textOutput);
console.log(`stop_reason=${result.stopReason}`);
for (const call of result.toolCalls) {
  console.log(`tool ${call.name} input=${JSON.stringify(call.input)}`);
}
```

What it does (from `core/sessions/run-one-shot.ts`):

- Create the environment if `environment.create` was passed (default if `environment` is omitted) and remember whether to archive it on exit.
- Create the session against `agent + environment_id`.
- Open the SSE event stream **before** sending the kickoff message - the session starts running on the first inbound `user.message`; streaming after the send can miss the first `agent.message`.
- Accumulate `agent.message` text blocks; record every `agent.tool_use` / `agent.custom_tool_use` into `toolCalls` (with `session_thread_id` for multiagent observation).
- Return on the first `session.status_idle` (single-agent) or `session.thread_status_idle` whose `parent_thread_id` is null / undefined (the primary thread of a coordinator). Sub-thread idles are skipped.
- Throw on `session.status_terminated` / `session.thread_status_terminated` on the primary thread, and on `session.error`.
- Archive the session and (when we created it) the environment in `finally`.

Pass `onEvent` to observe every event without giving up the helper's accumulation:

```typescript
const result = await runOneShot({
  agent: lock.id,
  prompt: "...",
  onEvent: (event) => console.error(`[${event.type}]`),
});
```

Reuse an environment by passing its id instead of `{ create: true }`:

```typescript
const result = await runOneShot({
  agent: lock.id,
  prompt: "...",
  environment: { id: env.id },
  archiveEnvironmentOnExit: false,
});
```

When `environment.id` is passed, the helper defaults `archiveEnvironmentOnExit` to `false` so the env outlives the session.

### 2b. `runMultiTurn` - same session across N prompts

```typescript
import { readAgentLock, runMultiTurn } from "@pressw-llc/managed-agents";

const lock = readAgentLock("./agents/research-pair/agent.lock.json");
if (!lock) throw new Error("sync research-pair first");

const { turns } = await runMultiTurn({
  agent: lock.id,
  prompts: [
    "Summarize the codebase entry points.",
    "Now flag any auth-related modules.",
    "Output a markdown report.",
  ],
  environment: { create: true },
});

for (const t of turns) {
  console.log(`> ${t.prompt}`);
  console.log(t.textOutput);
}
```

Same lifecycle as `runOneShot`, but the loop runs once per `prompts[]`. The session retains conversation memory between turns so the developer does not resend prior context.

### 2c. CLI smoke

```bash
bunx pw-managed-agents run code-reviewer -m "Introduce yourself."
```

Internally this is `runOneShot` with `environment: { create: true }`. See `src/cli/commands/run.ts`. The generated `agents/<name>/run.ts` is the same call, scriptable via `bun agents/<name>/run.ts "..."`.

### 2d. Low-level path - custom event handling

Reach for the primitives when:

- The driver needs to react to tool calls mid-stream (route a tool confirmation, supply a custom-tool result).
- The driver needs to interrupt the model mid-turn.
- The agent is a multiagent coordinator and the driver wants per-child-thread observation - see `pw-agents-multiagent`.
- The driver is a long-lived chat process that interleaves `events.send` from multiple producers.

```typescript
import {
  createClient,
  createSession,
  isEventType,
  streamSession,
  sendUserMessage,
  sendInterrupt,
  sendToolConfirmation,
  type SessionEvent,
} from "@pressw-llc/managed-agents";

const client = await createClient();

const session = await createSession(
  { agent: lock.id, environment_id: env.id },
  client,
);

const stream = await streamSession(session.id, client);
await sendUserMessage(session.id, "Kick off.", client);

for await (const event of stream as AsyncIterable<SessionEvent>) {
  if (isEventType(event, "agent.message")) {
    for (const block of event.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  } else if (isEventType(event, "agent.tool_use")) {
    process.stderr.write(`[tool_use ${event.name}]\n`);
  } else if (
    isEventType(event, "session.status_idle") ||
    isEventType(event, "session.thread_status_idle")
  ) {
    break;
  } else if (isEventType(event, "session.error")) {
    throw new Error(`session error`);
  }
}
```

`isEventType` is a typed discriminator; the narrowed `event` carries the SDK's exact event shape inside the branch.

To interrupt mid-stream (user closed the tab, timeout fired):

```typescript
await sendInterrupt(session.id, { client });
```

Pass `sessionThreadId` to target a coordinator's child thread. See `pw-agents-multiagent`.

To reply to a tool confirmation:

```typescript
await sendToolConfirmation(session.id, {
  toolUseId,
  result: "allow",
  client,
});
```

`tool_use_id` carries the routing - no need to set `session_thread_id` on the reply; the server routes it back to the originating thread automatically.

### 2e. Loop exit signals

The same idle event type is emitted for both single-agent and coordinator primary threads. The helpers handle both:

| Event | When |
| --- | --- |
| `session.status_idle` | Older / single-agent surface. Terminal for `runOneShot` / one turn of `runMultiTurn`. |
| `session.thread_status_idle` with `parent_thread_id` null | Primary thread idled. Terminal. |
| `session.thread_status_idle` with `parent_thread_id` set | A multiagent child thread idled. Intermediate; keep streaming. |
| `session.status_terminated` / `session.thread_status_terminated` on the primary thread | Hard fail; throw. |
| `session.error` | Hard fail; throw. |

Look at `event.stop_reason.type` to discriminate between `end_turn`, `requires_action`, and `max_tokens` on idle. The helpers return `stop_reason` so the caller can branch on `requires_action` without reaching for the low-level loop.

## Phase 3 - Verify

### Confirm the run completed cleanly

`runOneShot` returns `{ sessionId, environmentId, stopReason, textOutput, toolCalls }`. Check:

- `stopReason === "end_turn"` for a normal completion.
- `stopReason === "requires_action"` means the model is parked on a tool confirmation or custom-tool result. The helper does not auto-reply; reach for the low-level path with `sendToolConfirmation` / `routeToolConfirmation` (see `pw-agents-multiagent`) or `runMultiTurn` if the next user prompt unsticks it.
- `stopReason === "max_tokens"` means the model hit the budget; chunk the prompt or split work across turns.

### List recent sessions

```bash
bunx pw-managed-agents list
```

The remote sessions block uses `client.sdk.beta.sessions.list({ limit: 10 })` and prints `<id> <status> <agent.id>`. Pass `--no-remote` to skip the API call when offline.

For programmatic inspection:

```typescript
import { createClient } from "@pressw-llc/managed-agents";

const client = await createClient();
const page = client.sdk.beta.sessions.list({ limit: 5 });
for await (const s of page) {
  console.log(`${s.id} agent=${s.agent.id} status=${s.status}`);
}
```

> Reading sessions through `client.sdk.beta.sessions.*` directly is the escape hatch - the library does not yet wrap `list` / `retrieve` because the read surface is stable enough that wrapping it would just be ceremony.

### Archive on demand

`runOneShot` / `runMultiTurn` archive on exit by default. To archive manually:

```typescript
import { archiveSession } from "@pressw-llc/managed-agents";

await archiveSession(sessionId);
```

## Pitfalls

- **Open the stream before sending the kickoff message.** The session is created idle; the first `user.message` kicks it into `running`. Subscribing after the send drops the first `agent.message` on slow links. The helpers do this in the right order; the low-level path has to do it explicitly.
- **`runOneShot` only handles `end_turn`.** A `requires_action` stop on the primary thread returns the helper to the caller with `stopReason === "requires_action"`. The caller has to inspect `toolCalls`, decide allow / deny, and either drop to the low-level loop or let `runMultiTurn` carry the conversation forward.
- **Multiagent sub-thread idles are intermediate, not terminal.** The helpers skip `session.thread_status_idle` events that carry a `parent_thread_id`. A low-level loop that breaks on the first idle event will exit early on coordinator runs.
- **Environment archive defaults flip based on who owns it.** `archiveEnvironmentOnExit` defaults to `true` when the helper created the env and `false` when the caller passed an `id`. Override either way explicitly when the lifecycle matters (a long-lived shared env should not be archived by an accidental smoke test).
- **Archive on exit is best-effort.** The `finally` block swallows archive errors so a session-level exception is not masked by a cleanup-time exception. A surviving session shows up in `list` until reaped or archived manually.
- **Concurrent senders race.** Two callers pushing `user.message` to the same session interleave on the model's input. Serialize sends per session if multiple producers exist (chat clients with sidecar daemons, etc.).
- **The library wraps the common SDK shapes; the SDK is the source of truth for new events.** `SessionEvent` is derived from the live `beta.sessions.events.stream` return type, so a new event type from the SDK lights up in `isEventType` automatically. If something doesn't typecheck after bumping the SDK, that's the typechecker doing its job; reach for `client.sdk.beta.*` directly if a brand-new event shape needs handling before the library catches up.
- **`stream` returns one stream per call.** Re-subscribing to follow up across SDK versions that don't keep the stream open is handled by `runMultiTurn` automatically. A custom multi-turn loop has to do this dance too; do not assume one `streamSession` call survives multiple `sendUserMessage` calls.
- **Don't archive an env you didn't create.** A shared env passed in by id (`environment: { id }`) outlives the session by default. Flipping `archiveEnvironmentOnExit: true` will silently kill the shared workspace for every other caller.

## References

- /docs/en/managed-agents/sessions - https://platform.claude.com/docs/en/managed-agents/sessions
- /docs/en/managed-agents/events-and-streaming - https://platform.claude.com/docs/en/managed-agents/events-and-streaming
- /docs/en/managed-agents/agent-setup - https://platform.claude.com/docs/en/managed-agents/agent-setup
- `packages/pw-managed-agents/src/core/sessions/` - `runOneShot`, `runMultiTurn`, `createSession`, `streamSession`, `sendUserMessage`, `sendInterrupt`, `sendToolConfirmation`
- Related skills: `pw-agents-create-agent`, `pw-agents-environments`, `pw-agents-multiagent`, `pw-agents-files`
