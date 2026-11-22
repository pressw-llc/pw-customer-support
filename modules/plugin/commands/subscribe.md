---
description: Subscribe to a support channel key prefix
argument-hint: <client[:project[:user]]>
allowed-tools: mcp__plugin_support_pw-support__subscription_add
---

Call the `subscription_add` tool of the `pw-support` server with `prefix` set to `$ARGUMENTS`. A prefix matches whole segments of a channel key, so `acme` matches `acme:portal:u1` and `ac` does not. Report whether the subscription was created or already existed.
