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
| `linear/adapter.ts` | Creates exactly one ticket per request under an advisory lock, syncs follow-ups, and runs the marker and wording gate for inbound comments                    |
| `linear/webhook.ts` | `createLinearWebhookIntake`: signature, replay window, idempotency, persist-then-process                                                                      |
| `reply/marker.ts`   | Marker and confirm rules, own-comment test, and the hold warning template                                                                                     |
| `reply/wording.ts`  | `WordingScorer` interface and the Jev implementation                                                                                                          |
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
- Treat a staff comment as internal unless it starts with `@external`. `classifyStaffComment` allows only ASCII space, tab, CR, and LF before the marker, and requires whitespace or the end of the body after it. A bare marker with no text stays internal.
- Treat `@confirm` as a confirm only when the whole trimmed body equals it and the comment has a parent. `confirmHeldReply` releases the latest held reply of the same author in that thread.
- Score a marked reply with one Jev `noul` judgment and multiply by 5. `createJevWordingScorer` does it. Store the raw judgment in `support.judgments` with kind `wording`. Hold below 2, send and flag from 2 to below 3, send from 3.
- Hold on a scorer error, a missing key, a non finite score, or text over `MAX_MESSAGE_CHARS`. The hold warning is a fixed template and carries no model text.
- Skip our own comments: a follow-up header, the hold warning prefix, a recorded Linear comment id, or the integration user id from `viewerId`.
- Verify the webhook in `linear/webhook.ts`: raw body signature in constant time, 60 second window, delivery id idempotency, 256 KiB cap, fail closed without a secret. Persist the comment and `comment.received` before any judgment.
- Post a follow-up as one quoted comment per message. End it with `Support message ID: <id>` and find an existing comment by that marker before posting. Mark messages inside the ticket description as delivered with the ticket.
- Give follow-ups the static checks only. No Jev injection judgment runs on them, because no agent reads them in V1.
- Redeliver undelivered follow-ups and stale inbound comments through `adapter.redeliver`.
- Keep stub-only helpers (`staffComment`, `deliverCommentWebhook`, `configureWebhook`) behind `@pw-support/channels/testing`.
- Run the adapter as a Lambda pipeline step in `pipelines/linear-outbound`. One adapter handles `triage.result.accepted`, `ticket.created`, `message.created`, and `comment.received`.

## Commands

```bash
bun test modules/channels
bun run dev:linear-stub
bunx pw-pipeline validate
```
