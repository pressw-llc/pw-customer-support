# Phase 3 Adversarial Review Dispositions

Two fresh reviewers, one per perspective, each kept in one session across rounds.
Result: correctness APPROVE in round 2. Security APPROVE in round 3.

## Security

| Round | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| 1 | A confirm sends the held body as first written after an edit | SHOULD-FIX | FIXED. An edit or a removal cancels the hold. `tests/phase-3-review.test.ts` S1. |
| 1 | A comment with no Linear user is treated as staff | SHOULD-FIX | FIXED. Any author that is not a plain user is internal and cannot confirm. S2 tests. |
| 1 | A late confirm releases a newer hold | SHOULD-FIX | FIXED. A confirm releases only an older hold whose warning is posted. S3 tests. |
| 1 | Released staff text keeps Linear markdown and internal URLs | CONSIDER | FIXED. Replies reach the customer as plain text. Linear URLs and images are dropped. |
| 1 | A comment before its ticket row is lost | CONSIDER | FIXED. The comment is parked and resolved when the ticket exists. |
| 1 | `signLinearWebhook` in the production barrel | CONSIDER | FIXED. Moved behind `/testing`. |
| 1 | `Linear-Delivery` is unsigned | CONSIDER | REJECTED. Linear signs the body only. The comment id key makes a replay harmless. |
| 2 | Edit order is not tracked | SHOULD-FIX | FIXED. `updatedAt` orders changes. A superseded comment is re-fetched from Linear. `tests/phase-3-round2.test.ts` N1. |
| 2 | The plain-text step deletes staff words | SHOULD-FIX | FIXED. Staff replies skip the HTML stripper. The stripper removes only real HTML. N2 tests. |
| 2 | Parked comments store unrelated comment bodies | SHOULD-FIX | FIXED. A parked row holds ids only. The body comes from Linear after the ticket exists. N3 tests. |
| 3 | An update during a fetch is not recorded | CONSIDER | DEFERRED to the Phase 5 branch as a hardening item. |
| 3 | A confirm fetches the held comment only when a change row exists | CONSIDER | DEFERRED to the Phase 5 branch as a hardening item. |
| 3 | An update with no `updatedAt` uses the receipt time | CONSIDER | DEFERRED to the Phase 5 branch as a hardening item. |
| 3 | The shared stripper misses custom elements and can consume prose between `<b` and `>` | CONSIDER | DEFERRED to the Phase 5 branch. No sink executes HTML. |
| 3 | A failed cancel notice is not retried | CONSIDER | REJECTED. The notice is a courtesy to the author. The customer path is unaffected. |
| 3 | `getComment` treats any not-found error as deleted | CONSIDER | DEFERRED to the Phase 5 branch: log the case. |

## Correctness

| Round | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| 1 | Stale inbound redelivery has no backoff and can starve newer comments | SHOULD-FIX | FIXED. Attempt tracking and capped backoff. C1 test. |
| 1 | A follow-up can be marked delivered while absent from the ticket | SHOULD-FIX | FIXED. Only fully included messages are marked. C2 tests. |
| 1 | The viewer-id check drops the key owner's comments | SHOULD-FIX | FIXED. The check is removed. C3 tests. |
| 1 | Live validation lines that cannot fail | SHOULD-FIX | FIXED. The flag band prints SKIP and fails without `--allow-skip`. |
| 1 | Redelivery queries cast ids to text and lack indexes | SHOULD-FIX | FIXED. C5 test. |
| 1 | Ordering clock, lazy expiry, follow-up latency, duplicate warnings, purge | CONSIDER | FIXED. C6 to C10 tests. |
| 1 | Merge `webhook_deliveries`, `message_deliveries`, and `replies` into other tables | CONSIDER | REJECTED. Each table carries its own idempotency key. |
| 1 | Advisory lock held across Linear calls | CONSIDER | REJECTED for V1 volumes. |
| 2 | An amended `0005` does not apply to a database that ran the old file | SHOULD-FIX | FIXED in process. The evidence script rebuilds the database from empty. `0005` was never pushed before this PR. |
| 2 | Parked comments store unrelated comment bodies | SHOULD-FIX | FIXED. Same fix as security round 2. |
| 2 | Quote-cap overflow, late-attachment marker, cancel feedback | CONSIDER | FIXED. C4 to C6 round-two tests. |
