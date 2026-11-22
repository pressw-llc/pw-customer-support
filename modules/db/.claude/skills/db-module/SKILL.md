---

name: db-module
description: Work in the db module: Postgres schema, hand-written migrations, the migration runner, and the append-only event stream. Use when you add a table, write a migration, or append events.
---

# db module

## Ownership

`modules/db` owns the Postgres schema `support`, the drizzle table definitions, the SQL migrations, the migration runner, and `appendEvent`.

## Rules

- Write migrations by hand in `migrations/NNNN_name.sql`. Make each one idempotent.
- Pipeline migrations live in `migrations/pipeline/` and run first. Do not add a client literal to them.
- Use UUID primary keys. Keep every table in the `support` schema.
- Append events only through `appendEvent`. A trigger rejects UPDATE, DELETE, and TRUNCATE on `support.events`.
- `appendEvent` takes a transaction-scoped advisory lock before the insert, and wraps a bare db handle in a transaction. Event appends serialize, so `seq` follows commit order and is a safe cursor for readers that poll `seq > cursor`.
- Keep a transaction that appends an event short. The lock holds until commit.
- Keep the drizzle schema in `src/schema.ts` in step with the SQL.
- Open the triage job in the request transaction. `persistInboundRequest` writes the request, the first message, `request.created`, the `triage_jobs` row, and `triage.job.opened` together.
- Decide a job claim with one `UPDATE ... RETURNING` in `claimTriageJob`. A `FOR UPDATE` CTE re-checks the eligibility predicate after a lock wait, so parallel claims yield one winner.
- Change a channel delay with one statement. Halve with a conditional `UPDATE` guarded by the job open time. Reset with one upsert.
- Release a job in one transaction with its `triage.job.released` event.
- `support.ticket_deliveries` tracks ticket redelivery attempts. `claimTicketRedeliveries` selects and marks due events under an advisory lock.
- Pass `now` and `timing` to every job function. Tests control the clock without sleeping.
- Complete a job through `submitTriageResult` or `submitHumanTriage`. Both validate against the contracts schema. An invalid result reopens the job for the cloud.
- A job is claimable only after `markIntakeComplete` or the intake grace period. This stops a worker from reading attachments the API has not stored yet.
- `support.judgments` keeps every raw Jev judgment for V2. `support.tickets` holds one row per request. `support.event_cursors` holds one cursor per adapter.
- `replies.ts` owns the reply loop. `persistInboundComment` stores the delivery id, the raw comment, and `comment.received` in one transaction. `storeInternalComment`, `resolveExternalReply`, and `confirmHeldReply` each lock the pending inbound row and finish it once, so a repeat does nothing.
- `support.replies` holds one row per marked comment: `held`, `sent`, `expired`, or `cancelled`, the wording score, and `flagged`. CHECK constraints require `expires_at` for a held row, `message_id` for a sent row, and a reason for a cancelled row. `applyCommentChange` cancels a held reply on an edit or a delete. `listFlaggedReplies` is the query for the admin UI. A hold expires after `REPLY_HOLD_TTL_SECONDS`.
- Messages carry `author_name` and `intake_completed_at`. `support.message_deliveries` records which messages reached Linear, through the ticket description or a comment. `claimFollowUpRedeliveries` and `claimStaleInboundEvents` apply the capped backoff and mark rows in the claiming query, never attempted rows first. Join events by `(payload->>'messageId')::uuid` or `(payload->>'inboundId')::uuid`, which the partial indexes serve.
- Store the Linear comment time as `inbound_comments.source_created_at`. Use it as the staff message display time, capped at the insert time, and to order a confirm against holds. `messages.inserted_at` defaults to `clock_timestamp()`, and the unread count compares it with `customer_last_read_at`.
- Store a comment on an issue with no ticket row as pending with a null `request_id`, an empty body, no author, and `refetch_required` true. `attachOrphanComments` attaches it when the ticket row appears, and `resolveOrphanComments` deletes it after 10 minutes. `lockPending` skips rows that need a refetch, so no finisher stores an empty body.
- `support.comment_changes` holds one row per comment: the action and `updated_at`, never text. `applyCommentChange` and `persistInboundComment` take a per-comment advisory lock so a create and a change cannot miss each other. `applyFetchedComment` applies a comment fetched from Linear and cancels a held reply whose text changed. `purgeStaleRecords` deletes change rows after 7 days.
- `inbound_comments.source_updated_at` is the `updatedAt` of the stored body. An update applies only when strictly newer. An update while `refetch_required` is true records its change row and returns `refetch_required`. An update with no `updatedAt` sets `refetch_required` on a known comment and records nothing for an unknown one. `applyFetchedComment` keeps `refetch_required` while a newer change row remains, and cancels a held reply when the fetched body or author differs from the stored row, and only stores a newer `updatedAt`. `listHeldInThread` lists the live holds a confirm must check. `support.tickets.linear_issue_id` is unique. `expireHeldReplies` and `purgeStaleRecords` run from the adapter redelivery tick.
- Keep a customer visible reply as a message with audience `external`. Internal staff comments use audience `internal` and never pass the customer queries.
- `admin.ts` holds the admin reads and writes. `ACK_STAFF_PREDICATE` defines the first staff action: author `staff` and origin `linear` or audience `external`, the values `storeInternalComment` and the reply release write. The request flags read `support.replies`: `flagged` is a flagged reply and `held` is an unexpired hold. `getAdminRequestDetail` returns the reply rows. Every settings write appends an `admin.*` event with the actor in the same transaction.
- `support.integrations` holds a Secrets Manager reference per scope and kind. A check constraint requires the reference to start with `pw-support/`. Never store a secret value.
- `support.projects.severe_cc_emails` holds the CC list for a project.
- `subscriptions.ts` owns `support.subscriptions`: one row per engineer subject and channel prefix. Match a prefix by whole segment with `channel_key = prefix OR left(channel_key, length(prefix) + 1) = prefix || ':'`. Never use `LIKE`. `listJobOffers` and `isJobOffered` share one predicate: open, intake done, no earlier laptop claim, and a matching subscription. `queryRequestSummaries` and `getRequestDetailForEngineer` return metadata, and message bodies only for a subscribed channel. Subscription changes append `mcp.subscription.*` events in the same transaction.
- Test against the Compose Postgres. Do not mock the database.

## Commands

```bash
bun run stack:up
bun run db:migrate
bun test modules/db
```
