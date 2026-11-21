---
name: pw-agents-auth
description: Set up authentication for any code that calls `@pressw-llc/managed-agents`. Load before publishing an agent, running a session, syncing a managed-agent skill, or touching `beta.agents.* / beta.sessions.* / beta.environments.* / beta.skills.* / beta.files.*` through this library. Covers both auth modes the library auto-detects (Claude Platform on AWS via SigV4 and the first-party Anthropic API key, optionally via AWS Secrets Manager), the `detectMode()` heuristic, and the `bunx pw-managed-agents doctor` smoke test that surfaces the common failure modes (missing beta access, wrong region, secret not parsed) before they show up as a 404 on the first request.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-managed-agents:*), Bash(aws:*)
metadata:
  area: pw-managed-agents
  api-beta: managed-agents-2026-04-01
---

# Auth for `@pressw-llc/managed-agents`

Every other `pw-agents-*` skill assumes the SDK client this skill stands up. The library auto-detects which auth mode to use; the developer's job is to set the right env vars and confirm with `doctor`.

## Phase 1 - Gather Requirements

Confirm with the developer:

- **Auth mode** - Claude Platform on AWS (SigV4, region-bound workspace, no API key on disk) or the first-party Anthropic API (`ANTHROPIC_API_KEY`)? The library picks the first when `ANTHROPIC_AWS_WORKSPACE_ID` and a region are both set; otherwise the API key path.
- **Beta access** - Managed Agents is gated. If the org has not been allowlisted for `managed-agents-2026-04-01`, every `beta.*` call returns 404. The `doctor` command does not call the API; the first sync / run does. Treat an unexplained 404 as a beta-access signal first, not a bug.
- **Key storage** - for the API key mode, is the key in a local `.env` (dev) or in AWS Secrets Manager (deployed)? The library accepts both via the same env vars.
- **AWS principal** - for SigV4 mode, the workspace is bound to a specific AWS account. Confirm the developer has `AWS_PROFILE` (or IRSA / SSO / instance role) wired to that account and to a principal allowed by the workspace's outbound web-identity federation policy.

## Phase 2 - Author

### 2a. Auto-detect (the 90% case)

```typescript
import { createClient } from "@pressw-llc/managed-agents";

const client = await createClient();
```

`createClient()` calls `detectMode()` internally. From `packages/pw-managed-agents/src/core/auth/factory.ts`:

- `ANTHROPIC_AWS_WORKSPACE_ID` set **and** (`AWS_REGION` or `AWS_DEFAULT_REGION`) set -> `claude-platform-aws`.
- otherwise -> `api-key`.

Code never has to branch on the mode; both paths return a `ManagedAgentsClient` with the same `client.sdk.beta.*` surface.

### 2b. Claude Platform on AWS (SigV4)

Required env:

```bash
export ANTHROPIC_AWS_WORKSPACE_ID=wrkspc_...
export AWS_REGION=us-east-1
export AWS_PROFILE=your-profile     # or use IRSA / SSO / instance role
```

One-time, per AWS account, the workspace's outbound web-identity federation must be enabled. Without this the SigV4 request signs but the workspace refuses to issue a session token:

```bash
aws iam enable-outbound-web-identity-federation \
  --profile your-profile
```

Override explicitly when needed (CI matrices, multiple workspaces in one process):

```typescript
import { createClient } from "@pressw-llc/managed-agents";

const client = await createClient({
  mode: "claude-platform-aws",
  workspaceId: "wrkspc_...",
  awsRegion: "us-east-1",
});
```

The library calls `await sdk.ready` so region / profile misconfiguration surfaces at `createClient()` time instead of on the first SDK call.

### 2c. First-party API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

For deployments, point at AWS Secrets Manager instead. The library reads the secret lazily so `ANTHROPIC_API_KEY` does not need to live in the process env:

```bash
export AWS_SECRET_NAME=prod/anthropic/api-key
export AWS_REGION=us-east-1
```

The secret can be the raw key, or a JSON object with either `ANTHROPIC_API_KEY` or `api_key` set. See `core/auth/secrets-manager.ts` for the parsing rules.

Loading from Secrets Manager requires the optional dependency `@aws-sdk/client-secrets-manager`. The library does not pull it in for SigV4-only or env-only deployments; install it explicitly when the secret path is in play:

```bash
bun add @aws-sdk/client-secrets-manager
```

Without the optional dep installed, the library throws a clear error pointing at the install command - it does not silently fall back to env.

### 2d. The beta header

The library sets `anthropic-beta: managed-agents-2026-04-01` on every request from either client, via the `defaultHeaders` argument passed to the underlying SDK constructor. Consumers never need to set the header by hand. If raw `client.sdk.*` calls need extra headers (custom Anthropic gateway, tracing), pass them through `defaultHeaders` on `createClient()`:

```typescript
const client = await createClient({
  defaultHeaders: { "x-trace-id": traceId },
});
```

`MANAGED_AGENTS_BETA_HEADER` is re-exported from the package if a script needs the literal string.

### 2e. Project config

`pw-managed-agents.config.ts` can pin auth overrides so the CLI commands (`sync`, `run`, `list`) pick them up without env munging:

```typescript
import { defineConfig } from "@pressw-llc/managed-agents/config";

export default defineConfig({
  auth: {
    mode: "claude-platform-aws",
    workspaceId: "wrkspc_prod_...",
  },
});
```

The config's `auth` block is shaped like `CreateClientOptions` and is passed through verbatim. Env still wins for the workspace id / region / key unless the config sets explicit values.

## Phase 3 - Verify

Run the doctor:

```bash
bunx pw-managed-agents doctor
```

Expected outcomes per `src/cli/commands/doctor.ts`:

- **All checks passed** - auth mode resolved, env required by that mode is present, config file (if any) loaded, agents / skills directories found. Exit 0.
- **`missing ANTHROPIC_AWS_WORKSPACE_ID` or `missing AWS_REGION`** - SigV4 mode auto-detected but env incomplete. Either export the missing var or fall back to `ANTHROPIC_API_KEY`.
- **`missing ANTHROPIC_API_KEY (or AWS_SECRET_NAME)`** - API key mode auto-detected but neither source is set.
- **`failed to load <config>:`** - the config file threw on dynamic import. Fix the syntax / install missing deps before running `sync` or `run`; `init`, `new`, and `skills install` keep working through this failure.

`doctor` does not hit the API. To smoke-test that auth itself works (and that the org is on the beta), run a single agent:

```bash
bunx pw-managed-agents list
```

The remote sessions block tries `client.sdk.beta.sessions.list({ limit: 10 })`. A clean list (even empty) means auth + beta access are wired; a 404 means the org is not on the beta; a 401 / 403 means the credentials themselves are wrong.

## Pitfalls

- **Missing beta access looks like a 404 on a working call.** The `doctor` command cannot detect this because it does not hit the API. The first real call (sync, run, or `list` with remote) is where the org's allowlist status surfaces.
- **`AWS_SECRET_NAME` toggles the loader.** If it is set in a local shell, the API-key client tries to read from Secrets Manager rather than `ANTHROPIC_API_KEY`. Either unset it for local dev or scope `AWS_PROFILE` so the secret call actually succeeds.
- **`@aws-sdk/client-secrets-manager` is optional.** The library's `package.json` lists it under `optionalDependencies`. If `AWS_SECRET_NAME` is set and the optional dep was not installed, the library throws on first use with a clear "install it" message; it never silently falls back to env.
- **`AnthropicAws extends Anthropic`.** Both modes return a `ManagedAgentsClient { sdk, mode }` whose `sdk` is shape-compatible. Code that reads `client.sdk.beta.agents.*` works identically across modes; do not branch on `client.mode` for normal calls.
- **Don't override the beta header.** `defaultHeaders` is merged but the library sets `anthropic-beta` last - overriding it puts you off the supported surface. If you need a different beta, fork via `client.sdk` directly and accept that the library wrappers will not know about the new shape.
- **One workspace per region.** Claude Platform workspaces are region-bound. A SigV4 client made with `AWS_REGION=us-east-1` cannot talk to a workspace pinned in `us-west-2`. Pin both in the same config.
- **Ids are org-scoped.** `agent.id`, `session.id`, `environment.id`, `thread.id` are all bound to the org that issued the credentials. A lock file from one org's sync is useless against another org's credentials.
- **Don't log the key.** The library does not log key material; client code should not either. `console.log(client)` prints the SDK object; that is fine. `console.log(secrets)` or printing `process.env.ANTHROPIC_API_KEY` is not.

## References

- /docs/en/managed-agents/agent-setup - https://platform.claude.com/docs/en/managed-agents/agent-setup
- /docs/en/managed-agents/multi-agent - https://platform.claude.com/docs/en/managed-agents/multi-agent (confirms `managed-agents-2026-04-01` is the active beta)
- `packages/pw-managed-agents/src/core/auth/` - the factory, AWS / API key clients, and Secrets Manager loader the library uses
- `packages/pw-managed-agents/src/cli/commands/doctor.ts` - the canonical environment check
- Related skills: `pw-agents-overview`, `pw-agents-create-agent`, `pw-agents-sessions`
