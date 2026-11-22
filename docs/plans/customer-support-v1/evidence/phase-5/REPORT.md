# Phase 5 Validation Report

Target environment: local stack with live Jev and a real Claude Code CLI on this laptop. Docker Compose runs Postgres 16, LocalStack 3, and a mock OIDC issuer. The API and the worker run as separate processes. A local Linear stub stands in for Linear.
Path exercised: `bash scripts/validate/phase-5-evidence.sh`. The script stops the stack, rebuilds from empty, runs `bun run check` with no API key, then runs `bun run validate:phase-5`, which makes two real `claude -p` runs.

```text
A12  PASS  live.log: "PASS A12 engineer A (subscription acme-v5-a12-...) offered job ... keyed acme-v5-a12-...:portal:<hash> (cloud wait 600s); engineer B (subscription ...:other) ..." with 0 offers and a refused claim
A13  PASS  live.log: "PASS A13 MCP refused the result (invalid_payload at category); job reopened status=open; events request.created>triage.job.opened>triage.job.claimed>triage.result.rejected; cloud worker then completed it"
A20  PASS  live.log: "PASS A20 real claude -p over the plugin MCP config (headersHelper=bin/pw-support headers ...) saw init tools mcp__pw-support__jobs_offers, mcp__pw-support__request_get, mcp__pw-support__requests_query, mcp__pw-support__subsc..." Session stream: live/a20-session.json
A28  PASS  live.log: "PASS A28 (1) subagent init tools=["mcp__pw_submit__submit_result"] (exactly one); (2) job ... completed claimed_by_kind=laptop claimed_by=eng-a-... outcome=agent; (3) ticket ACME-2 created in the stub" and "PASS A28 injection ... the watcher log shows nothing to do (injection_flagged), no subagent started". Run report: live/subagent-runs. Watcher process: live/watcher-process.txt

4 criteria: 4 pass, 0 fail, 0 not run
```

Two more live checks guard the review fixes:

- live.log "PASS B2 surface /mcp lists 6 tools ...; /mcp/laptop lists job_claim, job_renew, job_status, job_submit_result; laptop endpoint without a watcher credential" is refused.
- live.log "PASS B1 request ... holds an injection payload; requests_query, request_get (subscribed and unsubscribed engineer), and jobs_offers responses contain it=false".

Safety Laws on this run:

- No customer content to an LLM with a tool or open network: the interactive session receives state and counts only. The headless subagent holds one tool, receives only server-prepared and Jev-filtered content, and receives it only after its startup check passes. The child environment holds no API key.
- No extra trust for a laptop: A13 passes through the shared validation.

Limits of this proof:

- Claude Code cannot unload organization-managed plugins. The startup event lists them and their agents. None adds a tool, skill, or slash command, and the runner fails closed on those fields.
- The watcher credential is not a second factor. The interactive session and the watcher run as one OS user.
- The cloud worker completed the A13 job as human triage, because no Anthropic key exists.
