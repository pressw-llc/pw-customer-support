---

name: api-module
description: Work in the api module: the Hono HTTP server on Bun. Use when you add intake, admin, webhook, or MCP routes.
---

# api module

## Ownership

`modules/api` owns the HTTP surface. Today it serves `GET /health`. Later phases add intake routes, attachment upload, static checks, the Linear webhook, admin routes, and the MCP route.

## Rules

- Build the app in `createApp` so tests call `app.request` without a socket.
- Persist the request and its event before any processing.
- Scope every query by the project that owns the key.
- Import other modules only through their package entrypoint.

## Commands

```bash
bun run --filter @pw-support/api start
bun test modules/api
```
