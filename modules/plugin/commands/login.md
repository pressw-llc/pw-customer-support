---
description: Log in to the support API in your browser
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/pw-support" login)
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/pw-support" login`. The command opens the browser, waits for the callback on 127.0.0.1, and exits. It needs no keyboard input. Report the command output. If the output says the issuer or client is not configured, tell the user to set `PW_SUPPORT_ISSUER` and `PW_SUPPORT_CLIENT_ID` in the environment that starts Claude Code, and to restart it.
