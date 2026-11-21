# PressW Customer Support V1: Phased Plan

Pairs with [PRD.md](PRD.md). The PRD holds the phase diagram, `Decide This`, and Accepted Risk. This plan cites PRD IDs and does not restate them.

Coverage: `criteria: 29 total, 29 claimed, 0 orphaned`.

## Branch Model

- `epic/customer-support-v1` is the epic branch on the remote. One PR carries the epic to `main`.
- Each phase pushes a head ref named `feat/customer-support-v1-p<N>-<slug>` and opens a PR into the epic branch.
- A phase PR merges into the epic branch after the `pressw-agent` reviewer approves. Nothing merges to `main` without an owner instruction.

## Architecture Choices

These choices fill gaps the PRD leaves open. Each one follows a pattern already in a PressW repository.

| Area | Choice | Source |
| --- | --- | --- |
| Workspace packages | `@pw-support/<module>`, private, except `@pressw-llc/support-react` for `widget` | D2, D29 |
| HTTP server | Hono on `Bun.serve` in `modules/api` | D1 |
| Database | `drizzle-orm` over `postgres`, hand-written idempotent SQL migrations, Postgres schema `support` | `pr-automation` |
| Pipeline tables | The three pipeline migration files are copied into `modules/db`, because the published package ships no SQL | T4 |
| Validation | `zod` 3, one schema per contract in `modules/contracts` | pipelines peer range |
| Attachments | S3 bucket, LocalStack locally, server-side upload through the API | D22 |
| Wake messages | SQS standard queue with `DelaySeconds` set by `modules/triage`, plus a DLQ | D13, T5 |
| Triage worker | A Fargate pipeline step that claims the job, runs the Jev filter, runs the managed agent, and submits the result | D11, T7 |
| Agent sandbox | Environment networking `limited` with an empty host list, zero tools, zero MCP servers | D11 |
| Channel adapters | Lambda pipeline steps fed by an event dispatcher that reads the stream table | D18 |
| Secrets | AWS Secrets Manager, LocalStack locally | D21 |
| Token validation | One validator that checks issuer, audience, and JWKS. AWS uses the telemetry pool issuer. The local stack uses a mock OIDC issuer container. | D30 |
| Boundary lint | A Biome rule that rejects a deep import into another module | D3 |
| Coverage | `bun test --coverage` with a 0.85 threshold in `bunfig.toml` | D25 |
| Hooks | `.githooks` with a conventional-commit `commit-msg` hook and a `pre-push` check | D25 |
| MCP | Streamable HTTP route in `modules/api` | D27 |
| Laptop runner | The plugin starts `claude -p` with one MCP tool that submits the result | D34 |

## Stand-ins for Pending Owner Actions

| Pending item | Local stand-in | Criteria held as NOT RUN live |
| --- | --- | --- |
| Linear API key and sandbox team | A local Linear stub that serves the GraphQL operations the adapter uses and signs webhooks | A8, A14, A16, A27 against real Linear |
| Telemetry pool app client | Mock OIDC issuer container | A19 with a telemetry-pool user |
| AWS account | LocalStack and `cdk synth` | A22 |
| npmjs organization and token | `bun publish --dry-run` and a local registry | A23 |

Jev and Managed Agents run live. The shell holds both keys.

## Phases

### Phase 0: Foundation

**Objective:** The workspace builds, checks, and synthesizes with empty modules.
**Proves:** A21, A24, A25. D1, D2, D3, D22, D23, D24, D25.
**Inputs:** `pr-automation` tooling patterns, pipelines `.npmrc` shape.
**Work:** Bun workspace and nine module shells. `contracts` and `db` with the core schema and migrations. Compose stack. `scripts/check.ts`. Actions workflow. CDK skeleton. `.coderabbit.yaml`. Githooks. `.env.example`. Root skills.
**Dependencies / Blockers:** None.
**Exit Criteria:** A21, A24, A25 pass. `cdk synth` passes.
**Validation:** Run `bun run check` on a clean clone. Plant a deep import and confirm the lint run fails. Read the Actions log.
**Review Gate:** PR reviewer.
**Fan-out Budget:** none.
**Rollback / Safety:** Close the PR.
**Decommission / Cleanup:** Replace the `Repository state` section of `CLAUDE.md`.

### Phase 1: Intake and Widget

**Objective:** A customer submits a request from the widget and Postgres holds the request.
**Proves:** A1 to A4, A17. D4, D5, D7, D8, D9, D33.
**Inputs:** Phase 0.
**Work:** Intake routes, identity check, attachment upload, static checks, event append, rate limit. Widget with Shadow DOM. Example host app. T14 test artifact.
**Dependencies / Blockers:** None.
**Exit Criteria:** A1 to A4 and A17 pass on the local stack. T14 is verified or recorded as unsupported.
**Validation:** Playwright drives the example host app. Integration tests run against Compose.
**Review Gate:** PR reviewer, live validation.
**Fan-out Budget:** none.
**Rollback / Safety:** Close the PR.
**Decommission / Cleanup:** None.

### Phase 2: Triage to Linear

**Objective:** A stored request becomes one Linear ticket through the claim protocol and the sandboxed agent.
**Proves:** A5 to A11, A27. D10 to D15, D17, D32, D35.
**Inputs:** Phase 1. Jev key, Anthropic key. Linear key pending.
**Work:** Job table, atomic claim, lease, delay and backoff, wake queue, Jev filter, text extraction, agent definition, result validation, Linear adapter outbound, settings seed script, injection corpus.
**Dependencies / Blockers:** A Linear key and sandbox team gate the live run of A8 and A27.
**Exit Criteria:** A5 to A11 and A27 pass. T15 is verified.
**Validation:** Live Jev and live Managed Agents. Concurrency test for A9. Clock-controlled test for A10. Linear stub until the key arrives.
**Review Gate:** Adversarial review, live validation.
**Fan-out Budget:** none.
**Rollback / Safety:** The agent holds no tool and no network. Only deterministic code writes to Linear.
**Decommission / Cleanup:** Archive Linear tickets from each live run.

### Phase 3: Reply Loop

**Objective:** A marked staff comment reaches the customer and a customer follow-up reaches Linear.
**Proves:** A14 to A16. D18, D19, D20, D31.
**Inputs:** Phase 2.
**Work:** Linear webhook route with signature check, marker gate, Jev wording score, hold and confirm flow, follow-up sync, unread indicator.
**Dependencies / Blockers:** A Linear key gates the live run.
**Exit Criteria:** A14 to A16 pass.
**Validation:** Signed webhook payloads against the local API. Playwright reads the widget.
**Review Gate:** Adversarial review, live validation.
**Fan-out Budget:** none.
**Rollback / Safety:** An unmarked comment never leaves the internal audience.
**Decommission / Cleanup:** None.

### Phase 4: Admin UI

**Objective:** A PressW admin logs in, views requests, and manages settings.
**Proves:** A18, A19, A29. D21, D26, D30, D36.
**Inputs:** Phase 1. App client pending.
**Work:** Token validator, admin routes, Vite app with shadcn and Tailwind, request list and detail, acknowledgement timer, settings for projects, keys, integrations, and the CC list. Secret storage.
**Dependencies / Blockers:** The telemetry pool app client gates the live login of A19.
**Exit Criteria:** A18, A19, A29 pass.
**Validation:** Playwright against the mock issuer. `pg_dump` scan for key material.
**Review Gate:** PR reviewer, live validation.
**Fan-out Budget:** none.
**Rollback / Safety:** Admin routes fail closed.
**Decommission / Cleanup:** Retire the settings seed script for paths the UI covers.

### Phase 5: Laptop Plugin and MCP

**Objective:** An engineer subscribes to a channel and a laptop completes a triage job.
**Proves:** A12, A13, A20, A28. D16, D17, D27, D34.
**Inputs:** Phase 2, Phase 4 token validator.
**Work:** MCP route, subscription store, prefix match, plugin, laptop claim and result, headless runner.
**Dependencies / Blockers:** None.
**Exit Criteria:** A12, A13, A20, A28 pass with a real laptop session.
**Validation:** A real `claude -p` run claims and completes a job.
**Review Gate:** Adversarial review, live validation.
**Fan-out Budget:** none.
**Rollback / Safety:** A laptop result passes the same validation as a cloud result.
**Decommission / Cleanup:** None.

### Phase 6: Publish and Production

**Objective:** The widget publishes and the stack deploys.
**Proves:** A22, A23, A26. D6, D28, D29, D37.
**Inputs:** All phases. AWS account and npmjs organization pending.
**Work:** Release script for both registries, deploy script, Actions deploy workflow, runbook, skill audit.
**Dependencies / Blockers:** The AWS account gates A22. The npmjs organization gates A23.
**Exit Criteria:** A26 passes locally. A22 and A23 pass on AWS after the owner actions.
**Validation:** `cdk synth`, a LocalStack deploy of the supported resources, `bun publish --dry-run`.
**Review Gate:** Owner approval.
**Fan-out Budget:** none.
**Rollback / Safety:** No publish and no deploy runs without an owner instruction.
**Decommission / Cleanup:** Remove the Linear stub from any deployed path.
