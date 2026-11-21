---

name: channels-module
description: Work in the channels module: the adapter contract, the event dispatcher, the Linear client, ticket builder, and local stub. Use when you build or change a channel adapter.
---

# channels module

## Ownership

`modules/channels` owns the adapters and the dispatcher. The adapter contract (`ChannelAdapter`) lives in `@pw-support/contracts`. V1 ships the Linear adapter. Phase 2 covers the outbound ticket. Phase 3 adds the inbound comments.

## Layout

| File | Role |
| --- | --- |
| `dispatcher.ts` | Reads `support.events` by `seq` with a durable cursor per adapter. Delivers through a transport. Advances the cursor after success |
| `linear/client.ts` | GraphQL client, `SecretsProvider`, `envSecrets` |
| `linear/ticket.ts` | Builds the ticket. Customer text appears only in the quote block |
| `linear/adapter.ts` | Creates exactly one ticket per request under an advisory lock |
| `poller.ts` | SQS poller that calls a Lambda-shaped handler |
| `runtime.ts` | Builds the adapter runtime from the environment |
| `testing/linear-stub.ts` | In-memory Linear GraphQL server for tests and local runs |

## Rules

- Make every adapter idempotent. The dispatcher delivers at least once.
- Read events from the stream. Never read another adapter's state.
- Route by the project's `linear_team_id`. Without one, append `ticket.blocked` and create nothing.
- Write customer text only as quoted content. Strip markup, neutralize mentions, cap the length.
- Send the Linear key as the raw `Authorization` value with no Bearer prefix. Never log it.
- Treat a staff comment as internal unless it starts with `@external`. Phase 3 enforces this.
- Run the outbound step as a Lambda pipeline step in `pipelines/linear-outbound`.

## Commands

```bash
bun test modules/channels
bun run dev:linear-stub
bunx pw-pipeline validate
```
