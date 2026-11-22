# Demo

`bun run demo` runs the whole product on one machine. It needs Docker and `bun install`. It uses the Compose stack, a Linear stub, and the mock OIDC issuer. It sends nothing to Linear.

## Start

```bash
bun run demo
```

The command starts the Compose stack, migrates the database, creates the bucket and queues, builds the widget, and seeds the project `acme/demo` with the stub Linear team. It then starts these processes on free ports.

| Process | Role |
| --- | --- |
| API | `apps/server` with the Linear webhook route |
| Worker | Triage worker, sweeper, and dispatcher |
| Linear stub | Local Linear GraphQL API with a ticket viewer page |
| Admin app | Vite dev server with the mock issuer login |
| Host app | A stock React app with the widget |

The command prints the URLs and waits until each one answers. Logs go to `.demo/logs`.

## Walkthrough

1. Open the host app URL. Click the support launcher.
2. Submit a request with a short message and a small image or text file.
3. Open the Linear stub URL. The ticket `ACME-1` appears within about 10 seconds.
4. Post an internal comment: `bun run demo comment ACME-1 "Looking at the logs now."` The widget shows nothing.
5. Post a customer reply: `bun run demo comment ACME-1 "@external We found the cause and a fix ships today."` The widget shows the reply and the unread badge.
6. Open the thread to clear the badge. Reply as the customer. The stub viewer shows the follow-up as a comment.
7. Open the admin app. Sign in at the mock issuer with any user name. Review the request list, the acknowledgement timer, and the request detail.
8. Post a blunt reply such as `@external hey, whatever, check back later`. A low wording score holds it. The author releases it with `@confirm` as a staff comment. The admin request detail shows the held reply.
9. Open Settings to see the project, its key, and the Linear team.

`bun run demo status` prints the URLs again.

## Without Jev or the agent

The demo prints which steps degrade.

- Without `TYPESAFE_API_KEY`, Jev is unavailable and the injection filter fails closed. Every request goes to human triage. The ticket still appears and carries the human triage label. An `@external` reply cannot be scored, so it is held until its author confirms with `@confirm`.
- Without a synced triage agent and `ANTHROPIC_API_KEY`, no managed agent runs. Tickets carry the human triage result and no agent summary.

Put the keys in `.env.local` with `bun run env set` to run the full path.

## Stop

```bash
bun run demo stop
```

The command stops the processes. It also stops the Compose stack when the demo started it.
