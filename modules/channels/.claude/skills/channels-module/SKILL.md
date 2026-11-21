---

name: channels-module
description: Work in the channels module: the adapter contract, the event dispatcher, the Linear client, ticket builder, and local stub. Use when you build or change a channel adapter.
---

# channels module

## Ownership

`modules/channels` owns the adapters and the dispatcher. The adapter contract (`ChannelAdapter`) lives in `@pw-support/contracts`. V1 ships the Linear adapter. Phase 2 covers the outbound ticket. Phase 3 adds the inbound comments.

## Layout

| File                | Role                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatcher.ts`     | Reads `support.events` by `seq` with a durable cursor per adapter. Delivers through a transport. Advances the cursor after success. Each tick also redelivers |
| `linear/client.ts`  | GraphQL client, `SecretsProvider`, `envSecrets`                                                                                                               |
| `linear/ticket.ts`  | Builds the ticket. Model text is inert, customer text appears only in the quote block, the marker is the last line                                            |
| `linear/adapter.ts` | Creates exactly one ticket per request under an advisory lock                                                                                                 |
| `poller.ts`         | SQS poller that calls a Lambda-shaped handler                                                                                                                 |
| `runtime.ts`        | Builds the adapter runtime from the environment                                                                                                               |
| `testing/`          | In-memory Linear GraphQL server and fixtures. Import from `@pw-support/channels/testing`                                                                      |

## Rules

- Make every adapter idempotent. The dispatcher delivers at least once.
- Read events from the stream. Never read another adapter's state.
- Route by the project's `linear_team_id`. Without one, append `ticket.blocked` and create nothing.
- Render the model title and summary as inert text: escape markdown, defang links and mentions, keep the title on one line.
- End every description with the marker line. Match an existing issue only when its last line equals the exact marker.
- Redeliver every `triage.result.accepted` event that has no ticket and whose project has a team, on a capped exponential backoff.
- Honor `LINEAR_API_URL` only when `NODE_ENV` is not `production`.
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
