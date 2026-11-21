import {
  hashCustomerId,
  intakeResultSchema,
  requestListSchema,
  SUPPORT_KEY_HEADER,
  SUPPORT_USER_HEADER,
} from "@pw-support/contracts";
import {
  closeDb,
  createDb,
  ensureProject,
  findProjectByKey,
  migrate,
} from "@pw-support/db";

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port ?? 0;
}

const PORT = Number(process.env.SMOKE_API_PORT) || freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const HEALTH_TIMEOUT_MS = 20_000;
const SECRET_TEXT = "B private request";
const PNG = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...Array(32).fill(1),
]);

let failures = 0;

function report(id: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
}

function check(id: string, expected: string, actual: unknown, ok: boolean) {
  report(id, ok, `${expected} (got ${String(actual)})`);
}

function randomSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

interface Tenant {
  key: string;
  email: string;
  hash: string;
}

async function createTenant(
  db: ReturnType<typeof createDb>,
  label: string,
  slug: string,
): Promise<Tenant> {
  const created = await ensureProject(db, {
    clientSlug: slug,
    projectSlug: "portal",
    name: `smoke ${label}`,
  });
  const resolved = await findProjectByKey(db, created.key);
  if (resolved?.project.id !== created.project.id) {
    throw new Error(`project ${label} key does not resolve in the database`);
  }
  const email = `${label}@smoke.test`;
  return {
    key: created.key,
    email,
    hash: await hashCustomerId(email, created.key),
  };
}

function headers(key: string, hash: string): Record<string, string> {
  return { [SUPPORT_KEY_HEADER]: key, [SUPPORT_USER_HEADER]: hash };
}

async function api(
  path: string,
  key: string,
  hash: string,
  init: { method?: string; body?: FormData } = {},
): Promise<Response> {
  return fetch(`${BASE}/v1${path}`, {
    method: init.method ?? "GET",
    headers: headers(key, hash),
    body: init.body,
  });
}

async function waitForHealth(
  child: ReturnType<typeof Bun.spawn>,
): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline && child.exitCode === null) {
    const ok = await fetch(`${BASE}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok && child.exitCode === null) return true;
    await Bun.sleep(250);
  }
  return false;
}

async function run(): Promise<void> {
  await migrate();
  const db = createDb();
  const suffix = randomSuffix();
  const slugs = [`smoke-a-${suffix}`, `smoke-b-${suffix}`];
  const child = Bun.spawn(["bun", "modules/api/src/server.ts"], {
    env: { ...process.env, API_PORT: String(PORT) },
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    const healthy = await waitForHealth(child);
    report(
      "HEALTH",
      healthy,
      healthy
        ? `GET /health answered on port ${PORT}`
        : `GET /health did not answer within ${HEALTH_TIMEOUT_MS} ms`,
    );
    if (!healthy) return;

    const [a, b] = await Promise.all([
      createTenant(db, "a", slugs[0] ?? ""),
      createTenant(db, "b", slugs[1] ?? ""),
    ]);
    report("SETUP", a.key !== b.key, "two fresh projects with distinct keys");

    const form = new FormData();
    form.set("text", SECRET_TEXT);
    form.append(
      "files",
      new File([PNG], "b-secret.png", { type: "image/png" }),
    );
    const submit = await api("/requests", b.key, b.hash, {
      method: "POST",
      body: form,
    });
    check(
      "B-SUBMIT",
      "project B submit returns 201",
      submit.status,
      submit.status === 201,
    );
    const created = intakeResultSchema.safeParse(
      submit.status === 201 ? await submit.json() : null,
    );
    const requestId = created.success ? created.data.requestId : "";
    const attachmentId = created.success
      ? (created.data.message.attachments[0]?.id ?? "")
      : "";
    report(
      "B-SUBMIT-ATTACHMENT",
      attachmentId !== "",
      "project B submit stored one attachment",
    );

    const own = await api("/requests", b.key, b.hash);
    const ownText = await own.text();
    check(
      "B-LIST",
      "project B list returns 200 and contains its request",
      own.status,
      own.status === 200 && ownText.includes(SECRET_TEXT),
    );

    const ownFile = await api(`/attachments/${attachmentId}`, b.key, b.hash);
    check(
      "B-ATTACHMENT",
      "project B fetches its attachment with 200",
      ownFile.status,
      ownFile.status === 200,
    );
    await ownFile.arrayBuffer();

    const cross = await api("/requests", a.key, b.hash);
    const crossText = await cross.text();
    const crossList = requestListSchema.safeParse(
      cross.status === 200 ? JSON.parse(crossText) : null,
    );
    check(
      "A17-LIST",
      "A17 key A with hash B lists zero requests and no B text",
      `status ${cross.status}, ${crossList.success ? crossList.data.requests.length : "invalid"} requests`,
      cross.status === 200 &&
        crossList.success &&
        crossList.data.requests.length === 0 &&
        !crossText.includes(SECRET_TEXT),
    );

    const thread = await api(`/requests/${requestId}`, a.key, b.hash);
    check(
      "A17-THREAD",
      "A17 key A cannot read B's thread (404)",
      thread.status,
      thread.status === 404,
    );
    await thread.text();

    const followUp = new FormData();
    followUp.set("text", "cross-project follow-up");
    const post = await api(`/requests/${requestId}/messages`, a.key, b.hash, {
      method: "POST",
      body: followUp,
    });
    check(
      "A17-FOLLOWUP",
      "A17 key A cannot post a follow-up to B's request (404)",
      post.status,
      post.status === 404,
    );
    await post.text();

    const read = await api(`/requests/${requestId}/read`, a.key, b.hash, {
      method: "POST",
    });
    check(
      "A17-READ",
      "A17 key A cannot mark B's thread read (404)",
      read.status,
      read.status === 404,
    );
    await read.text();

    const file = await api(`/attachments/${attachmentId}`, a.key, b.hash);
    check(
      "A17-ATTACHMENT",
      "A17 key A cannot fetch B's attachment (404)",
      file.status,
      file.status === 404,
    );
    await file.text();

    const unknown = await api("/requests", "pk_unknown_smoke_key", b.hash);
    check(
      "AUTH-UNKNOWN-KEY",
      "unknown key returns 401",
      unknown.status,
      unknown.status === 401,
    );
    await unknown.text();
  } finally {
    child.kill();
    await child.exited;
    await db.$client`delete from support.projects where client_slug in ${db.$client(slugs)}`;
    report("CLEANUP", true, "removed the two smoke projects");
    await closeDb(db);
  }
}

try {
  await run();
} catch (error) {
  failures++;
  console.log(
    `FAIL ERROR: ${error instanceof Error ? error.message : String(error)}`,
  );
}

console.log(failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
