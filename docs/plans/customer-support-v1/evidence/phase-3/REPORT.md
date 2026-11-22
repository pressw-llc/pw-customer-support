# Phase 3 Validation Report

Target environment: local stack with live Jev. Docker Compose runs Postgres 16 and LocalStack 3. The API and the worker run as separate processes. A local Linear stub stands in for Linear and sends signed webhooks.
Path exercised: `bash scripts/validate/phase-3-evidence.sh`. The script stops the stack, rebuilds the database from empty, runs `bun run check` with no API key, then runs `bun run validate:phase-3` against live Jev.

```text
A14  PASS  live.log: "PASS A14 unmarked comment ... stored internal and absent from the customer thread (1 message, unread 0); @external polite reply scored 4.15 sent as "Ada Staff" via linear, unread count 1". Screenshots: screenshots/a14-thread-staff-reply.png, screenshots/a14-unread-badge.png
A15  PASS  live.log: "PASS A15 held rude reply scored 0.05 (< 2) held and absent from the thread; warning comment ... posted in the thread by the integration; author @confirm sent it" and "PASS A15-flag-band borderline reply "Fixed in the latest build, retry." scored 2.65 on live Jev ... disposition sent_flagged, flagged true, returned by listFlaggedReplies"
A16  PASS  live.log: "PASS A16 widget follow-up posted to ACME-1 as one quoted comment ... after 32s of dispatcher ticks and a second sync (posted 0) the issue still holds 1 copy"

3 criteria: 3 pass, 0 fail, 0 not run
```

criteria-tests.log holds 19 hermetic `PASS A14`, `PASS A15`, and `PASS A16` lines with 0 failures.

The admin UI half of A15, "shows a flag in the admin UI", is proven in Phase 4. This run proves the flag exists and `listFlaggedReplies` returns it.

Safety Laws on this run:

- Never send a staff comment without the `@external` marker: A14 passes live. A randomized test checks 3000 comment bodies against an independent rule.
- Only deterministic code writes to Linear or to a customer: Jev output selects a band. Every warning, notice, and follow-up comment comes from a fixed template.
- Project isolation: a webhook resolves its issue to one ticket and one request.

Not run against real Linear: no Linear key exists. The stub signs webhooks the way Linear documents. Real payload fields for bot and external authors are unconfirmed, so any author that is not a plain user is stored as internal.
