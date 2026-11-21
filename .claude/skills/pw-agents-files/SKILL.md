---
name: pw-agents-files
description: Move files into and out of the sandboxed filesystem that backs a managed-agent environment, using `uploadFile / downloadFile / listFiles` from `@pressw-llc/managed-agents`. Load when seeding inputs before a session, exchanging artifacts mid-run, retrieving outputs at the end, or coordinating file access across multiple agents that share one environment. Covers `/workspace/inputs/*` and `/workspace/outputs/*` path conventions plus the multiagent shared-filesystem race window.
allowed-tools: Read, Write, Edit, Bash(bun run:*), Bash(bunx pw-managed-agents:*), Bash(shasum:*)
metadata:
  area: pw-managed-agents
  api-beta: managed-agents-2026-04-01
---

# Managed-agent files

Every session runs inside one environment, and that environment owns one sandboxed filesystem. All agents in a multiagent session share that filesystem. This skill covers how to push inputs in, retrieve outputs out, and avoid clobbering yourself when multiple threads write at once.

> The files surface is the youngest of the `managed-agents-2026-04-01` betas. The library wrappers track the current SDK shape (`beta.files.upload`, `beta.files.download`, `beta.files.list` keyed by `scope_id`); if the env-scoped surface lands or changes shape, the typechecker catches it. The conceptual flow below (seed inputs, agent reads from disk, pull outputs, archive) is stable.

## Phase 1 - Gather Requirements

Confirm with the developer (or read from the agent folder):

- **Inputs** - which files must land in the env before the agent runs (datasets, source code, configs, fixtures).
- **Outputs** - which artifacts to pull back at the end (reports, generated code, transformed data).
- **Binary vs text** - parquet, images, archives -> binary upload (`Uint8Array`). Source / markdown / JSON -> text is fine.
- **Lifetime** - inputs scoped to one session, or seeded into a shared env and reused?
- **Multiagent fan-out** - will multiple agent threads write to the same paths? If so, pick a path convention (`/workspace/threads/<thread-id>/...`) to avoid races.
- **Sensitivity** - any input that should never be pulled back to local disk? Make sure local dev does not bring it down and that the path is in `.gitignore`.

If the env does not exist yet, run `pw-agents-environments` first. If the session does not exist yet, run `pw-agents-sessions` after seeding.

## Phase 2 - Author

### 2a. Pre-session uploads (seed inputs)

Upload before creating the session so the agent finds the inputs already on disk under predictable paths.

```typescript
import { readFile } from "node:fs/promises";
import { uploadFile } from "@pressw-llc/managed-agents";

const bytes = await readFile("./fixtures/input.csv");

const file = await uploadFile(env.id, {
  path: "/workspace/inputs/input.csv",
  content: bytes,
  mimeType: "text/csv",
});
console.log(`uploaded ${file.filename} (${file.size_bytes ?? "?"} bytes)`);
```

`uploadFile` accepts either a `Uint8Array` (binary) or a `string` (UTF-8 text). The `path` argument carries the logical location inside the env; the library normalizes it into the upload filename so the agent's tools can resolve it consistently. See `core/files/upload.ts`.

For multi-file seeding, walk the local directory and upload each file. Keep the remote path convention stable (mirror the local `agents/<name>/inputs/` layout to `/workspace/inputs/`) so the agent's system prompt can reference predictable paths.

### 2b. In-session file IO

Once the session is running, the agent uses its own filesystem tools (bash, file editor) to read and write inside the env. The developer does not push files through `uploadFile` for normal model-driven IO; the agent already has direct filesystem access.

Use `uploadFile` mid-session only when the user supplies new inputs (chat client with an attachment). Push those before sending the next `user.message` so the agent finds them on the next turn.

### 2c. Post-session retrieval

After the session reaches `idle`, pull outputs back before archiving the env.

```typescript
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { downloadFile } from "@pressw-llc/managed-agents";

const remotePaths = ["/workspace/outputs/report.md", "/workspace/outputs/chart.png"];

for (const remote of remotePaths) {
  const bytes = await downloadFile(env.id, { path: remote });
  const local = `./out${remote}`;
  await mkdir(dirname(local), { recursive: true });
  await writeFile(local, bytes);
  console.log(`downloaded ${remote} -> ${local}`);
}
```

`downloadFile` returns the raw `Uint8Array`; write it through `node:fs` or `Bun.write`. The library hands you bytes, not a Blob - convert with `new TextDecoder().decode(bytes)` if you need a string.

Enumerate first when the developer does not know the artifact paths up front:

```typescript
import { listFiles } from "@pressw-llc/managed-agents";

const outputs = await listFiles(env.id, { prefix: "/workspace/outputs/" });
for (const f of outputs) {
  console.log(`${f.filename} ${f.size_bytes ?? "?"}`);
}
```

`listFiles({ prefix })` filters client-side after the API paginates, so it is convenient for short listings; for unbounded iteration walk `client.sdk.beta.files.list({ scope_id: envId })` directly.

### 2d. Convenience: round-trip per session

Glue the pieces together for a smoke test:

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  archiveEnvironment,
  createEnvironment,
  downloadFile,
  readAgentLock,
  runOneShot,
  uploadFile,
} from "@pressw-llc/managed-agents";

const lock = readAgentLock("./agents/transformer/agent.lock.json");
if (!lock) throw new Error("sync first");

const env = await createEnvironment({ name: "smoke-roundtrip" });
try {
  await uploadFile(env.id, {
    path: "/workspace/inputs/raw.csv",
    content: await readFile("./fixtures/raw.csv"),
    mimeType: "text/csv",
  });

  const result = await runOneShot({
    agent: lock.id,
    prompt: "Read /workspace/inputs/raw.csv, drop empty rows, write /workspace/outputs/clean.csv.",
    environment: { id: env.id },
    archiveEnvironmentOnExit: false,
  });
  console.log(result.textOutput);

  const clean = await downloadFile(env.id, { path: "/workspace/outputs/clean.csv" });
  await mkdir(dirname("./out/clean.csv"), { recursive: true });
  await writeFile("./out/clean.csv", clean);
} finally {
  await archiveEnvironment(env.id);
}
```

> Reach for `client.sdk.beta.files.*` directly only when the library wrappers cannot model the call (custom upload metadata not yet plumbed through `UploadFileInput`, chunked uploads beyond the SDK's single-shot path, etc.). The wrappers are intentionally thin; bypassing them is the supported escape hatch.

## Phase 3 - Verify

Confirm what the agent saw matches what was pushed, and what was pulled matches what the agent wrote.

```typescript
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { downloadFile, uploadFile } from "@pressw-llc/managed-agents";

async function sha256(bytes: Uint8Array | Buffer): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

const local = await readFile("./fixtures/input.csv");
const localSha = await sha256(local);

await uploadFile(env.id, {
  path: "/workspace/inputs/input.csv",
  content: local,
});

const remote = await downloadFile(env.id, { path: "/workspace/inputs/input.csv" });
if ((await sha256(remote)) !== localSha) {
  throw new Error("hash mismatch on input.csv");
}
```

Cross-checks:

- Listing the upload directory shows every file the developer pushed.
- The agent's session transcript references the input paths.
- For text artifacts, spot-check the contents; for binaries, hash both ends.

Run before archiving the env so a mismatch can be corrected while files are still reachable.

## Pitfalls

- **The filesystem is shared across agents in a multiagent session.** Threads can clobber each other's writes. Use per-thread subdirectories or a coordinator-enforced write contract; see `pw-agents-multiagent`.
- **Retrieve before archiving the environment.** Once the env is archived, its files may become unrecoverable depending on the live spec. Pull artifacts first.
- **Path conventions matter.** Agent system prompts often reference `/workspace/inputs/*` and `/workspace/outputs/*`. Uploading to a different prefix works for the upload call but the agent will not find the file. Mirror local conventions 1:1.
- **Encoding surprises.** Pass `Uint8Array` / `Buffer` for binary; pass strings only for UTF-8 text. The library encodes strings via `TextEncoder`; binary blobs handed through as strings are corrupted.
- **`mimeType` is a hint, not a contract.** Set it for downstream tools that key on MIME; do not rely on it for routing.
- **Large blobs may need chunking.** Single-shot uploads have size limits in the beta. If a payload is multi-MB, slice it and upload sequentially; the SDK does not auto-chunk.
- **Sensitive inputs leak via local checkouts.** Add input/output directories to `.gitignore`. A dev pulling artifacts down for inspection should not accidentally commit secrets the env had.
- **Race conditions on in-session writes.** Uploading to a path the agent is also writing to is last-write-wins. Avoid mid-session writes to paths the agent owns.
- **`environment_id` is required for every file call.** Files are per-environment; there is no global file pool. Track the env id alongside file ids in any manifest.
- **`listFiles` filter is client-side.** A large org with many files in a shared env can have the SDK paginator drain before the prefix filter selects anything; reach for the raw SDK call when you need server-side scoping beyond `scope_id`.
- **`TODO(beta)` comments in the library.** `upload.ts`, `download.ts`, and `list.ts` carry `TODO(beta)` markers tracking where the env-scoped surface is expected to land. The wrappers route the call to whatever the SDK exposes today; the bytes-in / bytes-out contract is stable.

## References

- /docs/en/managed-agents/files - https://platform.claude.com/docs/en/managed-agents/files
- /docs/en/managed-agents/environments - https://platform.claude.com/docs/en/managed-agents/environments
- /docs/en/managed-agents/multi-agent - https://platform.claude.com/docs/en/managed-agents/multi-agent (shared-filesystem semantics)
- `packages/pw-managed-agents/src/core/files/` - `uploadFile`, `downloadFile`, `listFiles` with the current `TODO(beta)` markers
- Related skills: `pw-agents-environments`, `pw-agents-sessions`, `pw-agents-multiagent`
