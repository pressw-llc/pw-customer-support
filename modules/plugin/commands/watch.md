---
description: Start, stop, or check the background triage watcher
argument-hint: start|stop|status
allowed-tools: Bash(pw-support watch start), Bash(pw-support watch stop), Bash(pw-support watch status)
---

Run exactly one command for the argument `$ARGUMENTS`:

- `start`: run `pw-support watch start`
- `stop`: run `pw-support watch stop`
- `status`: run `pw-support watch status`

If the argument is anything else, ask for `start`, `stop`, or `status`. Report the command output. If the output says you are not logged in, tell the user to run `pw-support login` in a terminal.
