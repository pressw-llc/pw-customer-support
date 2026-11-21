# Phase 1 Validation Report

Target environment: local stack. Docker Compose runs Postgres 16 and LocalStack 3 with S3.
Path exercised: `bun run stack:down`, then `bun run check`. Chromium drives the example host app against the running API. `bun run validate:phase-1` starts the API, creates two fresh projects, and asserts A17 over HTTP. It exits non-zero on any FAIL.

```text
A1   PASS     check.log: "A1: the widget renders from the host app inside a shadow root" and "A1: the widget stays usable under hostile host CSS". Screenshot: screenshots/a1-hostile-css.png
A2   PASS     check.log: "A2: text with two attachments persists the request, files, and request.created". criteria-tests.log: "PASS A2: request with text and two attachments persists request, files, and request.created". Screenshot: screenshots/a2-thread.png
A3   NOT RUN  The first half holds: criteria-tests.log "PASS D7: when static-check processing throws, the request row and request.created event still exist". No triage worker exists until Phase 2, so the restart half runs there.
A4   PASS     criteria-tests.log: four "PASS A4:" lines for the renamed executable, the 26 MB file, the eleventh file, and video. Screenshot: screenshots/a4-rejection.png
A17  PASS     live-smoke.log: "PASS A17-LIST: A17 key A with hash B lists zero requests and no B text (got status 200, 0 requests)", "PASS A17-THREAD", "PASS A17-FOLLOWUP", "PASS A17-READ", and "PASS A17-ATTACHMENT" each report 404. The positive controls read "PASS B-LIST" and "PASS B-ATTACHMENT" for project B. criteria-tests.log holds five "PASS A17:" lines.

5 criteria: 4 pass, 0 fail, 1 not run
```

Safety Laws exercised: project isolation by A17, commit before processing by the two D7 tests.

T14: NOT VERIFIED. A Claude artifact needs the widget bundle on a public CDN and a public API. Both arrive in Phase 6. The standalone bundle `dist/support-widget.global.js` exists for that test.
