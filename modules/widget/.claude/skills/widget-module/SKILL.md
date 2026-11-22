---

name: widget-module
description: Work in the widget module: the React support widget that client apps embed. Use when you change the widget UI, its Shadow DOM shell, its API client, or its build.
---

# widget module

## Ownership

`modules/widget` owns the package `@pressw-llc/support-react`. `SupportWidget` takes two required props, `projectKey` and `userEmail`, and optional `apiUrl` and `pollIntervalMs`. It renders a launcher with an unread badge and a panel with a new request form, a request list, and a thread view.

## Layout

| File                    | Role                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `SupportWidget.tsx`     | Creates the open Shadow DOM root, portals the shell into it, and owns view state and list polling |
| `components.tsx`        | `Composer`, `RequestList`, `ThreadView`, `AttachmentLink`, and `RejectionNotice`                  |
| `client.ts`             | Fetch client. It sends `X-Support-Key` and `X-Support-User` and throws `SupportApiError`          |
| `hash.ts`               | Wraps the contracts `hashCustomerId` helper                                                       |
| `styles.ts`             | One CSS string injected as a `<style>` in the shadow root                                         |
| `format.ts`             | Labels, size and time formatting, and customer-facing error text                                  |
| `use-polling.ts`        | Runs a task now and on an interval without overlap                                                |
| `mount.ts`, `global.ts` | `window.PressWSupport.mount` for script-tag use                                                   |
| `types.ts`              | Widget-owned types that mirror the contracts response schemas                                     |
| `testing/`              | `setup.ts` registers happy-dom. `fake-api.ts` replaces `fetch`                                    |

## Rules

- Treat React 18 or later as a peer dependency. Keep it external in the ESM build.
- Keep all styles in the shadow root. Set explicit color and font on `.root` and keep `:host { all: initial }`.
- Do not import a private workspace package in a type that reaches `dist/*.d.ts`. Keep widget types in `types.ts`.
- Bundle `@pw-support/contracts` into `dist` for the hash helper. Never list it as a runtime dependency.
- Poll for updates. Real-time push is out of scope for V1.
- Opening a thread marks it read.
- Show who replied and from which channel: `authorName (Support) via Linear`. Render every message body as plain text through React. Never use `dangerouslySetInnerHTML`.
- Fetch attachments with the auth headers and download a blob. A plain link cannot send headers.
- Keep labels, focus management, and keyboard support working: Escape closes the panel and returns focus to the launcher.

## Build output

`bun run build` writes `dist/index.js` (ESM), `dist/*.d.ts`, and `dist/support-widget.global.js` (IIFE with React). `SUPPORT_API_URL` sets the default API URL at build time. The package stays `private: true` until Phase 6.

## Commands

```bash
bun run build
cd modules/widget && bun test --coverage
bun run e2e
```
