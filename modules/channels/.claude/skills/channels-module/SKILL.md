---
name: channels-module
description: Work in the channels module: channel adapters that react to stream events. Use when you build the Linear adapter or the adapter contract.
---

# channels module

## Ownership

`modules/channels` owns the channel adapter contract and the adapters. V1 ships the Linear adapter: staff comments in, customer messages out. Adapters run as Lambda pipeline steps fed by stream events.

## Rules

- Treat a staff comment as internal unless it starts with `@external`.
- Send a marked comment out only after the wording gate passes.
- Store origin channel, author, and audience on every message.
- Read events from the stream. Never read another adapter's state.

## Commands

```bash
bun test modules/channels
```
