# Phase 2 Adversarial Review Dispositions

Two fresh reviewers, one per perspective, two rounds each in the same session.
Result: security APPROVE in round 2. Correctness closed F1 to F4 in round 2 and raised N1, fixed in `fix(db): cap the redelivery backoff exponent`.

## Security

| Finding | Severity | Disposition |
| --- | --- | --- |
| F1 Office XML extraction is quadratic and blocks the worker | SHOULD-FIX | FIXED. Linear scanners, 4 MB entry cap, extraction in a Worker with a 20 s timeout. `extract.test.ts` hostile office XML and isolated extraction. |
| F2 Agent summary renders as live markdown outside the quote | SHOULD-FIX | FIXED. Model text renders inert, links defanged in summary and quote. `ticket.test.ts` hostile summary and title. |
| F3 Filenames reach the agent unjudged | SHOULD-FIX | FIXED. Filenames join the judged message subject. `worker.test.ts` S3 tests. |
| F4 Chunks have no overlap | SHOULD-FIX | FIXED. 12 percent overlap plus a head-and-tail unit. `units.test.ts`. |
| F5 `needs_human` is discarded | SHOULD-FIX | FIXED. The human-triage label is added. `ticket.test.ts`, `linear.test.ts`. |
| Unjudged images reach the agent | CONSIDER | FIXED. An image without a clean Jev judgment is withheld and listed as not analyzed. |
| Marker match uses `contains` | CONSIDER | FIXED. The marker is the last line and the code checks it exactly. |
| Worker downloads every attachment | CONSIDER | FIXED. Only extractable kinds download, one at a time. |
| Test helpers in production barrels | CONSIDER | FIXED. Helpers sit behind `/testing` subpath exports. |
| Remote agent drift is unchecked | CONSIDER | FIXED. The worker verifies zero tools, MCP servers, and skills, then pins the verified version on each session. A missing field counts as unsafe. |
| `LINEAR_API_URL` override in production | CONSIDER | FIXED. Production ignores the override. |
| `&` entity links, backslashes in titles | CONSIDER | FIXED. `&` is escaped, titles strip control characters. |
| Extraction Worker has no heap limit | CONSIDER | DEFERRED to Phase 6. The deploy packaging sets the container memory limit. |
| Worker URL points at a `.ts` file | CONSIDER | DEFERRED to Phase 6. A startup extraction self-test lands with the bundled deploy. |
| `NODE_ENV=production` is not set by any deploy config | CONSIDER | DEFERRED to Phase 6. The CDK task definition sets it. |

## Correctness

| Finding | Severity | Disposition |
| --- | --- | --- |
| F1 Delay reset and halving are a non-atomic read-modify-write | SHOULD-FIX | FIXED. One guarded `UPDATE`, one upsert reset. `triage-jobs.test.ts` race tests on Postgres. |
| F2 A completed job can end with no ticket | SHOULD-FIX | FIXED. Redelivery covers any completed job without a ticket, with capped backoff. `linear.test.ts` C2 tests. |
| F3 Reopen paths send no wake, sweeper runs only in the dev script | SHOULD-FIX | FIXED. Backed-off wake on release, sweeper inside `runTriageWorker`, wake on an invalid result. |
| F4 Release commits state and event in separate transactions | SHOULD-FIX | FIXED. One transaction. `triage-jobs.test.ts`. |
| N1 `power(2, attempts)` overflows after 1024 attempts | SHOULD-FIX | FIXED. The exponent is capped at 20. The regression test fails without the cap with `value out of range: overflow`. |
| Heartbeat ignores a lost lease | CONSIDER | FIXED. A lost lease aborts the agent run. |
| Dead config field | CONSIDER | FIXED. Removed. |
| Shutdown does not await the in-flight tick | CONSIDER | FIXED. |
| Test helper marks neighbours as enqueued | CONSIDER | FIXED. `claimTicketRedeliveries` takes a request filter. |
| Three copies of the claimability predicate | CONSIDER | REJECTED in part. `handleWake` now claims first. The claim SQL and the sweeper filter stay separate, because a merge risks A9 to A11. |
| Timestamps come from the application clock | CONSIDER | REJECTED for now. A10 tests need the injected clock. The stack runs on one host until Phase 6. |
| Adapter visibility timeout versus batch time | CONSIDER | REJECTED. A duplicate delivery is harmless under the per-request lock. |
