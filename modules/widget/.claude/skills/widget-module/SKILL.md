---

name: widget-module
description: Work in the widget module: the React support widget that client apps embed. Use when you build the widget, its Shadow DOM shell, or its API client.
---

# widget module

## Ownership

`modules/widget` owns the package `@pressw-llc/support-react`. The intended widget renders in a Shadow DOM with bundled styles, takes a project key and a user email, lists requests, shows a thread, and shows an unread indicator.

## Rules

- Treat React 18 or later as a peer dependency.
- Compute the customer hash with the contracts helper.
- Poll for updates. Real-time push is out of scope for V1.
- Import other modules only through their package entrypoint.

## Commands

```bash
bun test modules/widget
```
