---

name: plugin-module
description: Work in the plugin module: the Claude Code plugin for laptop triage. Use when you build subscriptions, the claim flow, the watcher credential, or the headless runner.
---

# plugin module

## Ownership

`modules/plugin` owns the Claude Code plugin and the `pw-support` CLI. The interactive session manages channel subscriptions and queries request state over `/mcp`. The background watcher claims a triage job over `/mcp/laptop` and runs a headless `claude -p` subagent whose one tool submits the result.

## Layout

| Path                                        | Role                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json`, `.mcp.json`   | Manifest and the HTTP MCP server for `/mcp` with a `headersHelper`. Never declare `/mcp/laptop` here            |
| `commands/`, `skills/`, `bin/pw-support`    | Slash commands, the workflow skill, and the shell entry for the CLI                                             |
| `src/config.ts`                             | `loadPluginConfig(env, overrides)`. Seven `PW_SUPPORT_*` variables. Other values are constants or overrides     |
| `src/oauth.ts`, `pkce.ts`, `token-store.ts` | Authorization code with PKCE on a loopback port, refresh, client credentials, and the 0600 token file           |
| `src/watcher-credential.ts`                 | The per-machine watcher secret in a 0600 file                                                                   |
| `src/support-api.ts`                        | One reused MCP client per endpoint, the submit client, the 429 error, and the watcher register and revoke calls |
| `src/watcher.ts`                            | The watcher state machine. It takes the API, the runner, and the sleep as injected deps                         |
| `src/runner.ts`                             | The env allowlist, `verifyInit`, `StreamGuard`, the primer turn, the timeouts, and run directory cleanup        |
| `src/submit-server.ts`, `submit-main.ts`    | The stdio MCP server with the single `submit_result` tool, its config schema, and its process entry             |
| `src/daemon.ts`, `run-watch.ts`             | Pid file with nonce, log file, detached start, stop, status, and the `watch run` loop                           |
| `src/commands.ts`, `cli.ts`                 | The CLI dispatch and the entry. `cli.ts` and `run-watch.ts` are glue that no test loads                         |

## Rules

- Authenticate with the engineer's Cognito identity. Never log or print a token, except `pw-support token` and `pw-support headers`. `headers` prints the `Authorization` header and never the watcher secret.
- The interactive session never gets a job tool. Keep `.mcp.json` pointed at `/mcp`. The watcher alone calls `/mcp/laptop`, with the watcher credential. State plainly that the credential raises the bar and that the remaining boundary is the operating system.
- Give the headless subagent exactly one tool, `mcp__pw_submit__submit_result`. Keep `--tools ""`, `--strict-mcp-config`, `--permission-mode dontAsk`, and `--include-hook-events`.
- Write the request to stdin only after the init verifies. Claude Code emits init after the first user message, so send the neutral primer first.
- Kill the child and let the lease lapse on a foreign tool use, a foreign tool result, a hook other than `SessionStart`, or an unverifiable init. Fail closed on a missing field.
- Spawn the child with `buildChildEnv`. Add a name to `CHILD_ENV_NAMES` only when Claude Code needs it. Never add a secret that is not for Claude Code.
- Keep the claim token and the submit credential out of the model context, the child environment, and process arguments. The stdio server reads them from a 0600 config file. It never holds the engineer access token.
- Hand the model only the content the server prepared. Never read a request body in the watcher.
- Keep watcher logs and run reports free of request content. Log job ids, reasons, and counts.
- Let the lease lapse on a timeout and never retry a refused result.
- Delete the run directory in a `finally` and on SIGTERM and SIGINT.
- Hermetic tests inject a fake spawner or a fake `claude` script. Never invoke the real `claude` CLI in `bun run check`. Only `validate:phase-5` does.
- Submit results in the contracts triage result schema.
- Import other modules only through their package entrypoint.

## Commands

```bash
bun test modules/plugin tests/phase-5-plugin.test.ts
claude plugin validate modules/plugin
bun run validate:phase-5 --evidence-dir <dir>
```
