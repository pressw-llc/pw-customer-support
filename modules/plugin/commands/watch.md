---
description: Start, stop, or check the background triage watcher
argument-hint: start|stop|status
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/pw-support" watch start), Bash("${CLAUDE_PLUGIN_ROOT}/bin/pw-support" watch stop), Bash("${CLAUDE_PLUGIN_ROOT}/bin/pw-support" watch status)
---

Run exactly one command for the argument `$ARGUMENTS`:

- `start`: run `"${CLAUDE_PLUGIN_ROOT}/bin/pw-support" watch start`
- `stop`: run `"${CLAUDE_PLUGIN_ROOT}/bin/pw-support" watch stop`
- `status`: run `"${CLAUDE_PLUGIN_ROOT}/bin/pw-support" watch status`

If the argument is anything else, ask for `start`, `stop`, or `status`. Report the command output. If the output says you are not logged in, tell the user to run `/support:login`.
