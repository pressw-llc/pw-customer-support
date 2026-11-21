# Phase 2 Validation Report

Target environment: local stack with live Jev. Docker Compose runs Postgres 16 and LocalStack 3 with SQS and S3. The API and the worker run as separate processes. A local Linear stub stands in for Linear.
Path exercised: `bun run check` with no API key, the live injection corpus, and `bun run validate:phase-2 --partial` with a time factor of 0.14.

"Hermetic" below means real Postgres, SQS, and S3 with a fake agent session and the Linear stub.

```text
A3   PASS     live-partial.log: "PASS A3 worker stopped (SIGKILL), request ... stored (GET 200), job open with no ticket after 11s; worker restarted, job completed"
A5   PASS     live-partial.log: "PASS A5 ... labels=["needs-human-triage"] outcome=human_triage agent_session_id=null judgments=message:0.99 flagged". Live Jev scored the payload.
A6   NOT RUN  live. Hermetic: criteria-tests.log holds three "PASS A6" lines. The live run needs a non-empty ANTHROPIC_API_KEY.
A7   NOT RUN  live. Hermetic: criteria-tests.log "PASS A7 the definition has zero tools, zero MCP servers, and no skills" and "PASS A7 the environment restricts networking to an empty allowlist". The live read of the synced agent needs ANTHROPIC_API_KEY.
A8   NOT RUN  live. Hermetic: criteria-tests.log "PASS A8 a completed request becomes exactly one ticket in the project's team". The live run needs ANTHROPIC_API_KEY, and real Linear needs a Linear key and a sandbox team.
A9   PASS     live-partial.log: "PASS A9 ... 12 parallel claims, winners=1, refusals=11"
A10  PASS     live-partial.log: "PASS A10 scaled by 0.14: delays 8,4,2 (unscaled equivalent 60,30,15) ... after a laptop claim the next job waits 8s". criteria-tests.log asserts 60, 30, 15 unscaled with an injected clock.
A11  PASS     live-partial.log: "PASS A11 ... laptop claimed with a 17s lease and submitted nothing; cloud completed 1.0s after lease expiry; claimed_by_kind=cloud"
A27  NOT RUN  live. Hermetic: criteria-tests.log holds two "PASS A27" lines. The live run needs ANTHROPIC_API_KEY.

9 criteria: 5 pass, 0 fail, 4 not run
```

Injection corpus against live Jev, from corpus.log: "threshold 0.5: flag rate 30/30 (100.0%), false positives 0/30 (0.0%), lowest injection score 0.74, highest benign score 0.06".

T15: verified by the SQS poller path. `pipelines/pipelines.test.ts` runs the `linear-outbound` Lambda handler behind an SQS poller against LocalStack SQS. LocalStack Lambda was not tried.

Safety Laws on this run:

- No tool or network for the LLM that reads customer content: proven hermetically by the two A7 tests. The live read is NOT RUN.
- Only deterministic code writes to Linear: the adapter builds every ticket field. Customer text appears only inside the quote block.
- Commit before processing: A3 passes live.

Blockers, by exact item:

- A non-empty `ANTHROPIC_API_KEY` for A6, A7, A8, A27, the model id check, and `bun run agent:sync`.
- A Linear API key and a sandbox team id for the real Linear run of A8 and A27.
