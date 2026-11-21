---

name: admin-module
description: Work in the admin module: the staff admin UI. Use when you build request views, settings, the acknowledgement timer, or the login flow.
---

# admin module

## Ownership

`modules/admin` owns the admin app. It is a Vite React app with Tailwind v4, shadcn/ui, TanStack Query, `react-router-dom`, and `oidc-client-ts`. It shows the request list and detail, the acknowledgement timer, and settings for projects, keys, integrations, and the severe-request CC list.

## Layout

| Path                    | Role                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `src/main.tsx`          | Loads config, builds the providers, and gates the app on login             |
| `src/app/auth.tsx`      | `AuthProvider`: code flow with PKCE, session storage, silent renew, logout |
| `src/app/api.ts`        | Bearer fetch client, query options, and mutation hooks                     |
| `src/app/ack-timer.tsx` | `AckTimer` and the shared one second clock                                 |
| `src/app/pages/*`       | Requests, request detail, settings, projects panel, integrations panel     |
| `src/components/ui/*`   | shadcn components committed in the repository                              |
| `src/lib/*`             | Pure helpers with unit tests: config resolution and formatting             |

## Rules

- Call admin API routes with the ID token from the session. Never use `localStorage` for tokens.
- Start the login once. `AuthProvider` guards the effect with a `WeakSet`, because a second code exchange makes the issuer return a different user.
- A 401 starts a fresh login through `onUnauthorized`.
- Never show or store an integration secret. The settings fields are write-only. The API returns `configured` and update metadata.
- Render every thread body, summary, author name, and event payload as a React text node. Never use `dangerouslySetInnerHTML` or a markdown renderer. `e2e/admin.spec.ts` checks that markup in a message stays literal text.
- Show the reply loop from `detail.replies` (status, score, reason, expiry, warning) and the list flags from `flaggedReplies` and `heldReplies`. Both come from `support.replies`.
- Take the timer thresholds from `ACK_WARN_MINUTES` and `ACK_CRITICAL_MINUTES` in `@pw-support/contracts`.
- Keep logic in `src/lib` with a `bun test` file. The React code under `src/app` and `src/components` is outside the bun coverage run and has Playwright coverage in `e2e/admin.spec.ts`.
- Add shadcn components with `bunx --bun shadcn@latest add <name>` from this directory. The CLI rewrites the `cn` import, so check that it points at `@/lib/utils`.
- Import other modules only through their package entrypoint.

## Commands

```bash
bun run dev:admin
bun test modules/admin
bun run --filter @pw-support/admin build
bun run e2e
```
