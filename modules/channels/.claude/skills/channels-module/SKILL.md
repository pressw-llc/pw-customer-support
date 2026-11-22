---

name: channels-module
description: Work in the channels module: the adapter contract, the event dispatcher, the Linear client, ticket builder, and local stub. Use when you build or change a channel adapter.
---

# channels module

## Ownership

`modules/channels` owns the adapters and the dispatcher. The adapter contract (`ChannelAdapter`) lives in `@pw-support/contracts`. V1 ships the Linear adapter. Phase 2 covers the outbound ticket. Phase 3 adds the inbound comments.

## Layout

| File                | Role                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatcher.ts`     | Reads `support.events` by `seq` with a durable cursor per adapter. Delivers through a transport. Advances the cursor after success. Each tick also redelivers    |
| `linear/client.ts`  | GraphQL client, `SecretsProvider`, `envSecrets`. `getComment` returns null only for a definite entity-not-found result and throws on an auth or permission error |
| `linear/ticket.ts`  | Builds the ticket. Model text is inert, customer text appears only in the quote block, the marker is the last line                                               |
| `linear/adapter.ts` | Creates exactly one ticket per request under an advisory lock, syncs follow-ups, and runs the marker and wording gate for inbound comments                       |
| `linear/webhook.ts` | `createLinearWebhookIntake`: signature, replay window, idempotency, persist-then-process                                                                         |
| `reply/marker.ts`   | Marker and confirm rules, own-comment test, and the hold warning template                                                                                        |
| `reply/wording.ts`  | `WordingScorer` interface and the Jev implementation                                                                                                             |
| `poller.ts`         | SQS poller that calls a Lambda-shaped handler                                                                                                                    |
| `runtime.ts`        | Builds the adapter runtime from the environment                                                                                                                  |
| `testing/`          | In-memory Linear GraphQL server and fixtures. Import from `@pw-support/channels/testing`                                                                         |

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
- Treat `@confirm` as a confirm only when the whole trimmed body equals it and the comment has a parent. `confirmHeldReply` releases the latest held reply of the same author in that thread that is older than the confirm and already warned. A confirm that is early stays pending and retries. An earlier pending comment in the thread defers the confirm, except a recorded hold warning or cancel notice, because Linear may deliver our own comment webhook after the confirm.
- Treat a comment with no human Linear user as internal. The webhook stores `author_id` null for a missing `userId`, `botActor`, `externalUserId`, `externalUser`, or a non-user actor type. The adapter stores a null-author comment as internal before the confirm and marker rules run. Take the author name only from `data.user.name`.
- Accept `Comment` `update` and `remove` webhooks. A changed body or a delete cancels a held reply in the delivery transaction. An update that keeps the body changes nothing. An edit after send never changes the customer message.
- Order changes by the signed `data.updatedAt`. Apply an update only when it is strictly newer than `source_updated_at`. Record a change for an unknown comment in `comment_changes` with the action and time and no text. Never trust a create payload that a recorded change supersedes. Fetch the current comment with `linear.getComment` instead, and treat a missing comment as removed.
- Apply the same fetch rule before scoring a marked comment and before a confirm releases a held reply (`commentNeedsRefresh`, `listHeldInThread`, `applyFetchedComment`). A confirm fetches every live held comment of its thread every time and cancels the hold only when the body or author differs or the comment is gone, never on an `updatedAt` difference alone. A failed fetch throws, so the confirm stays pending. Store no body and no author for a comment on an issue with no ticket. The fetch supplies them once the ticket exists.
- Post one `Reply hold cancelled.` notice per cancelled hold, from the `reply.cancelled` event, found by its `Support reply cancel ID:` marker. A removed root comment gets a top level notice. A `@confirm` with no matching hold gets no response.
- Treat a payload without `createdAt` as internal. Treat an actor or user marked `app`, with a type other than `user`, a `botActor`, or an external user as non-human.
- Convert released staff text to plain text in `reply/plain-text.ts`: links to their text, images dropped, URLs on `linear.app` hosts dropped after a `URL` parse of each linear-scan candidate, in linear time. Never run the HTML stripper on staff text. The widget renders text nodes.
- Score a marked reply with one Jev `noul` judgment and multiply by 5. `createJevWordingScorer` does it. Store the raw judgment in `support.judgments` with kind `wording`. Hold below 2, send and flag from 2 to below 3, send from 3.
- Hold on a scorer error, a missing key, a non finite score, or text over `MAX_MESSAGE_CHARS`. The hold warning is a fixed template and carries no model text.
- Skip our own comments by the follow-up header, the hold warning prefix, or a recorded Linear comment id. Never skip by the key owner's user id: the key owner can write real staff comments.
- Mark a message delivered with the ticket only when the issue was created in that call, the message intake is complete, and its text fits the quote cap. `buildTicket` returns the ids it included. Post attachments that finish later as a filename list through follow-up sync.
- Give the hold warning a `Support reply ID: <id>` last line. Lock the reply row while posting, and look the warning up by that marker first.
- Verify the webhook in `linear/webhook.ts`: raw body signature in constant time, 60 second window, delivery id idempotency, 256 KiB cap, fail closed without a secret. Persist the comment and `comment.received` before any judgment.
- Post a follow-up as one quoted comment per message, or numbered parts of at most 4,000 characters (`Support message ID: <id> part N of M`) for a longer one. The first message posts only the text after the head the ticket description holds. Stop the description at the first message that is not ready. End it with `Support message ID: <id>` and find an existing comment by that marker before posting. Mark messages inside the ticket description as delivered with the ticket.
- Give follow-ups the static checks only. No Jev injection judgment runs on them, because no agent reads them in V1.
- Redeliver undelivered follow-ups and stale inbound comments through `adapter.redeliver`, each on a capped exponential backoff. `redeliver` also attaches or expires orphan comments, expires holds, and purges old webhook rows.
- Subscribe to `message.intake_completed` so a finished follow-up intake posts at once.
- Keep stub-only helpers (`staffComment`, `editComment`, `removeComment`, `deliverCommentWebhook`, `configureWebhook`, `signLinearWebhook`) behind `@pw-support/channels/testing`. The production barrel exports only the verifier.
- Run the adapter as a Lambda pipeline step in `pipelines/linear-outbound`. One adapter handles `triage.result.accepted`, `ticket.created`, `message.created`, and `comment.received`.

## Commands

```bash
bun test modules/channels
bun run dev:linear-stub
bunx pw-pipeline validate
```
