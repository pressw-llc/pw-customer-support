---

name: plugin-module
description: Work in the plugin module: the Claude Code plugin for laptop triage. Use when you build subscriptions, the claim flow, or the headless runner.
---

# plugin module

## Ownership

`modules/plugin` owns the Claude Code plugin. The intended plugin manages channel subscriptions, claims a triage job over MCP, runs a headless `claude -p` subagent whose one tool submits the result, and queries request state.

## Rules

- Authenticate with the engineer's Cognito identity.
- Submit results in the contracts triage result schema.
- Import other modules only through their package entrypoint.

## Commands

```bash
bun test modules/plugin
```
