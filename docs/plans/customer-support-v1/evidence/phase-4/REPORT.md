# Phase 4 Validation Report

Target environment: local stack. Docker Compose runs Postgres 16, LocalStack 3 with Secrets Manager, and a mock OIDC issuer. The API validates real signed tokens from that issuer. No auth bypass exists.
Path exercised: `bash scripts/validate/phase-4-evidence.sh`. The script stops the stack, rebuilds from empty, runs `bun run check` with no API key, then runs `bun run validate:phase-4`. Chromium drives the admin app through a real authorization-code login.

```text
A18  PASS     live.log: "PASS A18a Secrets Manager holds the saved key", "PASS A18b the database dump holds no key material - pg_dump", "PASS A18c no admin API response holds the key", "PASS A18d the API logs hold no key", "PASS A18e no event payload holds the key". Screenshot: screenshots/admin-integrations-after.png
A19  PASS     against the mock issuer. live.log: "PASS A19 401 without a token - status 401", "PASS A19 401 with a token signed by another key", "PASS A19 401 with a token from another issuer", "PASS A19 200 with a token from the local issuer". criteria-tests.log: "A19: a staff member logs in through the mock issuer and sees the request list". Screenshot: screenshots/admin-requests.png
A29  PASS     live.log: "PASS A29 the saved CC list is returned on the next read". criteria-tests.log: "A29: a saved CC list survives a reload". Screenshot: screenshots/admin-cc-list.png
A15  PASS     admin half. live.log: "PASS A15-admin the admin API returns the flagged reply to staff and 401 without a token". criteria-tests.log: "A15: a reply scored 2.5 sends and shows a flag in the admin UI". Screenshot: screenshots/admin-a15-flag.png shows "Flagged" and "score 2.50".

3 phase criteria: 3 pass, 0 fail, 0 not run. A15 is owned by Phase 3 and completed here.
```

A19 with a telemetry-pool user: NOT RUN. The owner has not yet granted an app client on the telemetry Cognito pool. The validator checks issuer, audience, signature, and expiry the same way for both issuers.

Safety Laws on this run:

- No integration secret in Postgres, a log, an event, or an API response: A18 a to e pass.
- Admin routes fail closed: A19 passes for a missing token, a forged token, and a foreign issuer.

A full check failed once on a fresh stack before this run. The cause was a test harness that deleted its fixtures while a stub webhook was still in flight. The harness now waits for in-flight webhooks, and the webhook path answers "ignored" for a request that no longer exists. Three consecutive fresh-stack checks passed after the fix.
