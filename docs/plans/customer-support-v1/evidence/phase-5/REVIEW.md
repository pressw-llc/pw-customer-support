# Phase 5 Adversarial Review Dispositions

Two fresh reviewers, one per perspective, each kept in one session across rounds.
Result: security APPROVE in round 2. Correctness approved the round-one fixes in round 2 and raised three small items, fixed before this PR.

## Security

| Round | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| 1 | `request_get` returns raw customer text into the engineer's tooled session | BLOCKER | FIXED. Interactive tools return state and counts only. A contract test walks every output schema against an allowlist. |
| 1 | The interactive session can call `job_claim` and `job_submit_result` | BLOCKER | FIXED. `/mcp` registers six tools. Job tools live on `/mcp/laptop`, which needs a watcher credential. |
| 1 | The headless guard checks tools once, and the child inherits the full environment | SHOULD-FIX | FIXED. Environment allowlist, request withheld until the startup check passes, kill on any foreign tool call or hook. A real run shows one tool for the whole stream. |
| 1 | Content can go to a lost lease, renew revives an expired lease | CONSIDER | FIXED. |
| 1 | The submit server holds the engineer's full token | CONSIDER | FIXED. It holds a credential bound to one job, valid for the lease, for `job_submit_result` only. |
| 1 | A killed watcher leaves run files on disk | CONSIDER | FIXED. Run directories are removed in `finally`, on signals, and by a purge at start. |
| 1 | The admin email-domain check rejects plugin tokens | CONSIDER | FIXED. `/mcp` has its own optional group policy and returns 403 on failure. |
| 2 | The submit credential can renew | CONSIDER | FIXED. The submit scope registers one tool. |
| 2 | The kill only detects | CONSIDER | FIXED in docs. README states that prevention rests on `--tools ""`, the strict MCP config, the per-turn startup check, and `dontAsk`. |
| 2 | A repeated startup event re-sends the request | CONSIDER | FIXED. A sent flag. |
| 2 | `MCP_REQUIRED_GROUP` is off by default | CONSIDER | DEFERRED to Phase 6 as a deploy setting. Production logs a startup warning when the group is unset. |
| 2 | Watcher credentials never expire | CONSIDER | REJECTED for V1. Logout revokes the credential, and the credential is not a second factor. |

## Correctness

| Round | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| 1 | `job_claim` prepares inside the lease and returns a stale expiry | SHOULD-FIX | FIXED. The lease extends after preparation. A lost lease returns no content, releases the job, and sends a wake. |
| 1 | A stale pid file can signal an unrelated process | SHOULD-FIX | FIXED. The pid file holds a nonce that must appear in the command line. |
| 1 | `extendTriageLease` revives an expired lease | SHOULD-FIX | FIXED. A renew needs a live lease. |
| 1 | Rate-limit accounting can starve renew and submit | SHOULD-FIX | FIXED. Only `tools/call` counts. Renew and submit have their own bucket. |
| 1 | `api` and `triage` depend on each other | SHOULD-FIX | FIXED. The entry moved to `apps/server`. `lint-boundaries` fails on a workspace cycle. |
| 1 | Judgments recorded twice on a redo | CONSIDER | REJECTED. Judgments are an append-only record, the same as on a cloud retry. |
| 2 | `/mcp/laptop` runs an unindexed lookup before any limit | SHOULD-FIX | FIXED. A malformed credential header gets 401 before any query. A partial index covers the lookup. |
| 2 | Migration `0007` changed after it ran locally | SHOULD-FIX | FIXED in process. `0007` was never pushed. The evidence script rebuilds every database from empty. |
| 2 | Phase 5 evidence logs were deleted | SHOULD-FIX | FIXED. `check.log`, `live.log`, and `criteria-tests.log` are regenerated from the final code. |
| 2 | Concurrent connect, unverifiable pid, uncertain delivery after a transport error | CONSIDER | FIXED. |
