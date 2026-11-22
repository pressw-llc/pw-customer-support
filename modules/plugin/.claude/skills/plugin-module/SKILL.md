---

name: plugin-module
description: Work in the plugin module: the Claude Code plugin for laptop triage. Use when you build subscriptions, the claim flow, or the headless runner.
---

# plugin module

## Ownership

`modules/plugin` owns the Claude Code plugin and the `pw-support` CLI. The plugin manages channel subscriptions, queries request state, claims a triage job over MCP, and runs a headless `claude -p` subagent whose one tool submits the result.

## Layout

| Path                                        | Role                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json`, `.mcp.json`   | Manifest and the HTTP MCP server with a `headersHelper`                                               |
| `commands/`, `skills/`, `bin/pw-support`    | Slash commands, the workflow skill, and the shell entry for the CLI                                   |
| `src/config.ts`                             | `loadPluginConfig(env)` reads the `PW_SUPPORT_*` variables                                            |
| `src/oauth.ts`, `pkce.ts`, `token-store.ts` | Authorization code with PKCE on a loopback port, refresh, client credentials, and the 0600 token file |
| `src/support-api.ts`                        | Typed MCP client for `jobs_offers`, `job_claim`, `job_renew`, and `job_submit_result`                 |
| `src/watcher.ts`                            | The watcher state machine. It takes the API, the runner, and the sleep as injected deps               |
| `src/runner.ts`                             | Starts `claude -p`, enforces the exact tool set from `system/init`, applies the timeout               |
| `src/submit-server.ts`, `submit-main.ts`    | The stdio MCP server with the single `submit_result` tool, and its process entry                      |
| `src/daemon.ts`, `run-watch.ts`             | Pid file, log file, detached start, stop, status, and the `watch run` loop                            |
| `src/commands.ts`, `cli.ts`                 | The CLI dispatch and the entry. `cli.ts` and `run-watch.ts` are glue that no test loads               |

## Rules

- Authenticate with the engineer's Cognito identity. Never log or print a token, except `pw-support token` and `pw-support headers`.
- Give the headless subagent exactly one tool, `mcp__pw_submit__submit_result`. Keep `--tools ""`, `--strict-mcp-config`, and `--permission-mode dontAsk`. Kill the run when the `init` tool list is not exact.
- Keep the claim token out of the model context. Pass it to the stdio server through its environment only.
- Hand the model only the content the server prepared. Never read a request body in the watcher.
- Keep watcher logs free of request content. Log job ids, reasons, and counts.
- Let the lease lapse on a timeout and never retry a refused result.
- Hermetic tests inject a fake spawner. Never invoke the real `claude` CLI in `bun run check`. Only `validate:phase-5` does.
- Submit results in the contracts triage result schema.
- Import other modules only through their package entrypoint.

## Commands

```bash
bun test modules/plugin tests/phase-5-plugin.test.ts
claude plugin validate modules/plugin
bun run validate:phase-5 --evidence-dir <dir>
```
