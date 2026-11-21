# Multiagent event types

Companion to `pw-agents-multiagent/SKILL.md`. Catalogue of the events you observe on the primary thread vs an individual child thread for a coordinator session under the `managed-agents-2026-04-01` beta. Source: `/docs/en/managed-agents/multi-agent` and `/docs/en/managed-agents/events-and-streaming`.

The library re-exports the SDK's event union as `SessionEvent` from `@pressw-llc/managed-agents`. `isEventType(event, "agent.message")` narrows to the SDK's exact shape inside the branch.

## Event prefix conventions

| Prefix | Meaning |
| --- | --- |
| `session.*` | Lifecycle / status events about a thread or the session aggregate. |
| `agent.*` | Activity produced by an agent (the coordinator or a specialist). |
| `user.*` | Events the client sends inbound (messages, interrupts, tool confirmations). |

## Primary-thread events

Open via `streamSession(sessionId)`. The primary thread shows the coordinator's full activity plus a condensed view of every child thread.

| Type | Description | Key fields |
| --- | --- | --- |
| `session.thread_created` | A new thread was spawned by the coordinator. | `session_thread_id`, `agent_name` |
| `session.thread_status_running` | A thread started or resumed activity. | `session_thread_id` |
| `session.thread_status_idle` | A thread is awaiting input (normal completion or blocking event cross-posted from a child). | `session_thread_id`, `agent_name`, `stop_reason`, `parent_thread_id` |
| `session.thread_status_terminated` | A thread was archived or hit a terminal error. | `session_thread_id` |
| `agent.thread_message_received` | A specialist delivered a result to the coordinator. | `from_session_thread_id`, `from_agent_name`, `content` |
| `agent.thread_message_sent` | The coordinator dispatched a follow-up to a specialist. | `to_session_thread_id`, `to_agent_name`, `content` |

### `stop_reason` shape

`session.thread_status_idle` carries `stop_reason`. The cases that matter for control flow:

| `stop_reason.type` | Meaning |
| --- | --- |
| `end_turn` | Agent finished a turn cleanly. Multi-turn callers can send the next `user.message`. |
| `requires_action` | Agent is blocked awaiting `user.tool_confirmation` or `user.custom_tool_result`. Includes `event_ids` for pending tool uses. Cross-posted to the primary thread if it originated in a child. |
| `max_tokens` | Hit the token budget. |

### Primary-vs-child discrimination

`parent_thread_id` is null (or missing) for the primary thread and set for children. The library's `runOneShot` / `runMultiTurn` helpers use this to skip intermediate child-thread idles; custom drivers must do the same:

```typescript
if (isEventType(event, "session.thread_status_idle")) {
  const c = event as unknown as { parent_thread_id?: string | null };
  if (c.parent_thread_id) continue;
  // primary-thread idle -> terminal for this turn
  break;
}
```

## Session-thread events

Open via `streamThread(threadId, { sessionId })`. A child thread's full activity (every model turn, every tool call) is here.

| Type | Description |
| --- | --- |
| `agent.message` | A model turn. `content` is an array of blocks (`{type: "text", text}`, etc.). |
| `agent.tool_use` | The agent invoked a tool. Carries `session_thread_id` for multiagent observation. |
| `agent.custom_tool_use` | The agent invoked a custom (client-implemented) tool. |
| `agent.tool_result` | The result of a tool call. |
| `session.thread_status_running` | The thread (re)started. |
| `session.thread_status_idle` | The thread is awaiting input. Same `stop_reason` shape as on the primary thread. |
| `session.thread_status_terminated` | The thread ended. |

For the primary thread (`thread_id` equal to the session's primary thread id), this stream is equivalent to `streamSession`.

## Inbound user events

Sent via `sendEvents(sessionId, { events: [...] })` or one of the convenience wrappers (`sendUserMessage`, `sendInterrupt`, `sendToolConfirmation`, `routeToolConfirmation`).

| Type | When to use | Required fields | Library wrapper |
| --- | --- | --- | --- |
| `user.message` | Push a new user turn (kickoff or follow-up). | `content` | `sendUserMessage` |
| `user.interrupt` | Cancel a thread. Omit `session_thread_id` to target the primary thread; include it to target a specific child. | (optional `session_thread_id`) | `sendInterrupt`, `interruptThread` |
| `user.tool_confirmation` | Approve or deny an `always_ask` / MCP confirmation tool call. | `tool_use_id`, `result` (`"allow"` / `"deny"`) | `sendToolConfirmation`, `routeToolConfirmation` (kind: "confirm") |
| `user.custom_tool_result` | Supply the result of a client-side custom tool. | `custom_tool_use_id`, `content` | `routeToolConfirmation` (kind: "custom_result") |

### Cross-thread routing

When a specialist blocks on `requires_action`, the `session.thread_status_idle` event is cross-posted to the primary thread with `session_thread_id` identifying the originating child. The reply (`user.tool_confirmation` or `user.custom_tool_result`) goes to the **session** events endpoint **without** `session_thread_id`. The server routes the reply to the originating child by `tool_use_id` / `custom_tool_use_id`.

## Lifecycle quick reference

```
created  ->  running  ->  idle (end_turn)         <- normal turn complete, awaiting user
                       ->  idle (requires_action) <- blocked, needs user.tool_confirmation
                       ->  idle (max_tokens)
                       ->  terminated             <- archived or terminal error
```

`archiveThread` is only valid from `idle`. Use `interruptThread` first to force `idle` from `running` or `requires_action`.

## See also

- /docs/en/managed-agents/events-and-streaming - full event-and-streaming reference
- /docs/en/managed-agents/multi-agent - primary-thread vs session-thread semantics and cross-thread routing rules
- `packages/pw-managed-agents/src/core/sessions/types.ts` - `SessionEvent` derivation from the SDK
- `packages/pw-managed-agents/src/core/multiagent/threads.ts` - thread lifecycle wrappers
