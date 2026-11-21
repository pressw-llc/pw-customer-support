---

name: contracts-module
description: Work in the contracts module: zod schemas and types that every other module shares. Use when you add or change a shared schema, event type, channel key rule, or limit.
---

# contracts module

## Ownership

`modules/contracts` owns every shared shape: channel keys, the event envelope and event types, message enums, the identity hash, attachment limits, the triage result schema, and the shared resource names.

## Rules

- Export schemas and their inferred types from `src/index.ts` only.
- Use zod 3. The pipeline package requires it.
- Keep the module free of I/O and of imports from other modules.
- Add a test beside each schema. Cover both accepted and rejected input.
- Add new event types to `eventTypes` in `src/events.ts`. The array is the single source for the enum.
- `triage-job.ts` holds the job status, claimant, outcome, and human triage reason enums, the timing defaults, the delay halving rule, and the wake message shape. `humanTriageResult()` builds the deterministic fallback result.
- `admin.ts` holds the admin request, project, key, and integration schemas, the `INTEGRATIONS` table that maps a kind to its secret name and env variable, `secretId`, the acknowledgement thresholds, and `ackState`.
- `stack-config.ts` also derives the local OIDC issuer from `SUPPORT_OIDC_PORT`.
- `channel-adapter.ts` holds the adapter contract, the adapter queue names, and the adapter message shape.

## Commands

```bash
bun test modules/contracts
bun run --filter @pw-support/contracts typecheck
```
