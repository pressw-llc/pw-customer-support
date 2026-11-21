---
name: admin-module
description: Work in the admin module: the staff admin UI. Use when you build request views, settings, or the acknowledgement timer.
---

# admin module

## Ownership

`modules/admin` owns the admin app. The intended app is a Vite React app with shadcn and Tailwind behind Cognito login. It shows the request list and detail, the acknowledgement timer, and settings for projects, keys, integrations, and the severe-request CC list.

## Rules

- Call admin API routes with a Cognito token.
- Never show or store an integration secret. The API returns a reference only.
- Import other modules only through their package entrypoint.

## Commands

```bash
bun test modules/admin
```
