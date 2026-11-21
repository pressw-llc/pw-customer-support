import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { createSecretsManagerClient } from "@pw-support/channels";
import {
  adminProjectSchema,
  adminRequestDetailSchema,
  adminRequestListSchema,
  integrationStatusSchema,
  mintedKeySchema,
  secretId,
} from "@pw-support/contracts";
import {
  attachments,
  events,
  inboundComments,
  integrations,
  messages,
  projects,
  recordAttachmentRejection,
  recordJudgments,
  replies,
  requests,
} from "@pw-support/db";
import { eq, like } from "drizzle-orm";
import { z } from "zod";
import { dumpDatabase } from "./testing/dump";
import { fixtures } from "./testing/fixtures";
import { createHarness, form } from "./testing/harness";
import {
  otherSigningKey,
  startTestIssuer,
  type TestIssuer,
} from "./testing/oidc";

const ADMIN_ORIGIN = "http://admin.test";
const scope = `t-${crypto.randomUUID().slice(0, 8)}`;
const clientSlug = `acme-adm-${crypto.randomUUID().slice(0, 6)}`;

let idp: TestIssuer;
let harness: Awaited<ReturnType<typeof createHarness>>;
let bearer: Record<string, string>;
const sm = createSecretsManagerClient();

beforeAll(async () => {
  idp = await startTestIssuer();
  harness = await createHarness({
    config: {
      auth: idp.authConfig(),
      adminOrigins: [ADMIN_ORIGIN],
      secretsScope: scope,
      admin: { maxBodyBytes: 2048, mutationsPerWindow: 1000 },
    },
  });
  bearer = { Authorization: `Bearer ${await idp.token()}` };
});

afterAll(async () => {
  await harness.db.delete(projects).where(eq(projects.clientSlug, clientSlug));
  await harness.db.delete(integrations).where(eq(integrations.scope, scope));
  idp.stop();
  sm.destroy();
  await harness.close();
});

function admin(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = bearer,
) {
  return Promise.resolve(
    harness.app.request(`/admin${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function createProject(slug: string) {
  const response = await admin("POST", "/projects", {
    clientSlug,
    projectSlug: slug,
    name: `Project ${slug}`,
  });
  expect(response.status).toBe(201);
  return adminProjectSchema.parse(await response.json());
}

describe("A19: admin routes fail closed", () => {
  const routes: [string, string][] = [
    ["GET", "/me"],
    ["GET", "/requests"],
    ["GET", `/requests/${crypto.randomUUID()}`],
    ["GET", `/attachments/${crypto.randomUUID()}`],
    ["GET", "/projects"],
    ["POST", "/projects"],
    ["PATCH", `/projects/${crypto.randomUUID()}`],
    ["PUT", `/projects/${crypto.randomUUID()}/cc-list`],
    ["POST", `/projects/${crypto.randomUUID()}/keys`],
    [
      "POST",
      `/projects/${crypto.randomUUID()}/keys/${crypto.randomUUID()}/revoke`,
    ],
    ["GET", "/integrations"],
    ["PUT", "/integrations/linear_api_key"],
  ];

  test("every route returns 401 without a token", async () => {
    for (const [method, path] of routes) {
      const response = await admin(method, path, undefined, {});
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
  });

  test("every route returns 401 for forged and invalid tokens", async () => {
    const forged = await idp.token({ signWith: await otherSigningKey() });
    const wrongAudience = await idp.token({ claims: { aud: "x" } });
    for (const token of [
      forged,
      wrongAudience,
      idp.unsignedToken(),
      await idp.hmacToken(),
      "garbage",
    ]) {
      for (const [method, path] of routes) {
        const response = await admin(method, path, undefined, {
          Authorization: `Bearer ${token}`,
        });
        expect(response.status).toBe(401);
      }
    }
  });

  test("a valid token reaches the route and identifies the staff member", async () => {
    const response = await admin("GET", "/me");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sub: "staff-1",
      email: "ada@pressw.test",
      name: "Ada Admin",
    });
  });

  test("an unconfigured validator rejects a token that would be valid", async () => {
    const closed = await createHarness({
      config: { auth: idp.authConfig({ issuer: undefined }) },
    });
    try {
      const response = await closed.app.request("/admin/me", {
        headers: bearer,
      });
      expect(response.status).toBe(401);
    } finally {
      await closed.close();
    }
  });

  test("a JWKS outage returns 401", async () => {
    const outage = await startTestIssuer();
    const closed = await createHarness({
      config: { auth: outage.authConfig() },
    });
    const token = await outage.token();
    outage.failing(true);
    try {
      const response = await closed.app.request("/admin/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
    } finally {
      outage.stop();
      await closed.close();
    }
  });
});

describe("admin CORS", () => {
  test("allows the configured origin, including the preflight without a token", async () => {
    const preflight = await harness.app.request("/admin/projects", {
      method: "OPTIONS",
      headers: {
        Origin: ADMIN_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      ADMIN_ORIGIN,
    );
    const response = await admin("GET", "/me", undefined, {
      ...bearer,
      Origin: ADMIN_ORIGIN,
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ADMIN_ORIGIN,
    );
  });

  test("does not allow another origin, unlike intake", async () => {
    const response = await admin("GET", "/me", undefined, {
      ...bearer,
      Origin: "https://evil.example",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const intake = await harness.app.request("/health", {
      headers: { Origin: "https://evil.example" },
    });
    expect(intake.status).toBe(200);
  });
});

describe("admin requests", () => {
  test("lists a seeded request with the acknowledgement fields and filters", async () => {
    const project = await createProject("requests");
    const key = await mintKey(project.id);
    const who = await harness.asTenant(project.id, key, "grace@acme.test");
    const created = await harness.call(
      who,
      "POST",
      "/requests",
      form("The export fails", [
        { name: "app.log", bytes: fixtures.text("boom\n"), type: "text/plain" },
      ]),
    );
    expect(created.status).toBe(201);
    const { requestId: id } = (await created.json()) as { requestId: string };

    const listed = await admin("GET", `/requests?projectId=${project.id}`);
    const list = adminRequestListSchema.parse(await listed.json());
    expect(list.items).toHaveLength(1);
    const item = list.items[0];
    expect(item?.id).toBe(id);
    expect(item?.customer).toHaveLength(8);
    expect(item?.channelKey).toBe(`${clientSlug}:requests`);
    expect(item?.acknowledgedAt).toBeNull();
    expect(item?.ticket).toBeNull();
    expect(item?.preview).toBe("The export fails");
    expect(Date.parse(item?.createdAt ?? "")).toBeGreaterThan(0);

    const open = await admin(
      "GET",
      `/requests?projectId=${project.id}&status=open&flaggedReplies=false&needsHuman=false`,
    );
    expect(adminRequestListSchema.parse(await open.json()).items).toHaveLength(
      1,
    );
    const flagged = await admin(
      "GET",
      `/requests?projectId=${project.id}&flaggedReplies=true`,
    );
    expect(
      adminRequestListSchema.parse(await flagged.json()).items,
    ).toHaveLength(0);
    expect((await admin("GET", "/requests?limit=0")).status).toBe(400);
  });

  test("returns the thread, timeline, reply flags, and an attachment download", async () => {
    const project = await createProject("detail");
    const key = await mintKey(project.id);
    const who = await harness.asTenant(project.id, key, "hopper@acme.test");
    const created = await harness.call(
      who,
      "POST",
      "/requests",
      form("Please look at this", [
        { name: "shot.png", bytes: fixtures.png(), type: "image/png" },
      ]),
    );
    const { requestId: id } = (await created.json()) as { requestId: string };
    await harness.db.insert(messages).values({
      requestId: id,
      body: "internal note",
      originChannel: "linear",
      author: "staff",
      audience: "internal",
    });
    const [inbound] = await harness.db
      .insert(inboundComments)
      .values({
        commentId: `c-${crypto.randomUUID()}`,
        issueId: "issue-detail",
        body: "@external hold me",
        requestId: id,
        status: "processed",
      })
      .returning();
    await harness.db.insert(replies).values({
      requestId: id,
      inboundCommentId: (inbound as NonNullable<typeof inbound>).id,
      threadRootId: "root-detail",
      authorName: "Ada Staff",
      body: "hold me",
      status: "held",
      holdReason: "wording_low",
      wordingScore: 1.2,
      heldAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      warningCommentId: "w-detail",
    });

    const [firstMessage] = await harness.db
      .select()
      .from(messages)
      .where(eq(messages.requestId, id));
    const [requestRow] = await harness.db
      .select()
      .from(requests)
      .where(eq(requests.id, id));
    await recordAttachmentRejection(harness.db, {
      message: firstMessage as NonNullable<typeof firstMessage>,
      request: requestRow as NonNullable<typeof requestRow>,
      filename: "setup.exe",
      sizeBytes: 12,
      reason: "executable",
    });
    await recordJudgments(harness.db, [
      {
        requestId: id,
        kind: "injection",
        subject: "private customer text",
        score: 0.2,
        threshold: 0.5,
        flagged: false,
        raw: {},
      },
    ]);

    const response = await admin("GET", `/requests/${id}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("private customer text");
    const detail = adminRequestDetailSchema.parse(JSON.parse(body));
    expect(detail.rejections).toEqual([
      { filename: "setup.exe", reason: "executable", sizeBytes: 12 },
    ]);
    expect(detail.judgments).toHaveLength(1);
    expect(detail.judgments[0]).toMatchObject({
      kind: "injection",
      flagged: false,
    });
    expect(detail.messages.map((message) => message.audience)).toEqual([
      "external",
      "internal",
    ]);
    expect(detail.messages[1]?.originChannel).toBe("linear");
    expect(detail.request.heldReplies).toBe(true);
    expect(detail.request.acknowledgedAt).not.toBeNull();
    expect(detail.replies).toHaveLength(1);
    expect(detail.replies[0]).toMatchObject({
      status: "held",
      score: 1.2,
      holdReason: "wording_low",
      authorName: "Ada Staff",
      warningPosted: true,
    });
    expect(detail.events.map((event) => event.type)).toContain(
      "request.created",
    );
    expect(
      detail.claims.every((event) => event.type.startsWith("triage.job.")),
    ).toBe(true);
    expect(detail.job?.status).toBe("open");
    const attachment = detail.messages[0]?.attachments[0];
    expect(attachment?.filename).toBe("shot.png");

    const download = await admin("GET", `/attachments/${attachment?.id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain("shot.png");
    expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(
      Buffer.from(await download.arrayBuffer()).equals(
        Buffer.from(fixtures.png()),
      ),
    ).toBe(true);
  });

  test("returns 404 for unknown and malformed ids", async () => {
    expect(
      (await admin("GET", `/requests/${crypto.randomUUID()}`)).status,
    ).toBe(404);
    expect((await admin("GET", "/requests/not-a-uuid")).status).toBe(404);
    expect(
      (await admin("GET", `/attachments/${crypto.randomUUID()}`)).status,
    ).toBe(404);
    expect((await admin("GET", "/attachments/nope")).status).toBe(404);
  });
});

async function mintKey(projectId: string): Promise<string> {
  const response = await admin("POST", `/projects/${projectId}/keys`);
  expect(response.status).toBe(201);
  return mintedKeySchema.parse(await response.json()).key;
}

describe("admin projects and keys", () => {
  test("creates, edits, and lists a project with its Linear team", async () => {
    const created = await createProject("settings");
    expect(created.linearTeamId).toBeNull();
    expect(created.ccList).toEqual([]);
    const patch = await admin("PATCH", `/projects/${created.id}`, {
      name: "Renamed",
      linearTeamId: "team-9",
    });
    expect(patch.status).toBe(200);
    expect(adminProjectSchema.parse(await patch.json())).toMatchObject({
      name: "Renamed",
      linearTeamId: "team-9",
    });
    const listed = z
      .array(adminProjectSchema)
      .parse(await (await admin("GET", "/projects")).json());
    expect(listed.find((row) => row.id === created.id)?.linearTeamId).toBe(
      "team-9",
    );
    expect((await admin("PATCH", `/projects/${created.id}`, {})).status).toBe(
      400,
    );
    expect(
      (await admin("PATCH", `/projects/${crypto.randomUUID()}`, { name: "x" }))
        .status,
    ).toBe(404);
    expect((await admin("PATCH", "/projects/nope", { name: "x" })).status).toBe(
      404,
    );
  });

  test("rejects a duplicate project and invalid input", async () => {
    await createProject("dupe");
    const dupe = await admin("POST", "/projects", {
      clientSlug,
      projectSlug: "dupe",
      name: "Again",
    });
    expect(dupe.status).toBe(409);
    expect(
      (
        await admin("POST", "/projects", {
          clientSlug: "a:b",
          projectSlug: "p",
          name: "n",
        })
      ).status,
    ).toBe(400);
    const notJson = await harness.app.request("/admin/projects", {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
  });

  test("A29: saves the cc list, normalizes it, and returns it on the next read", async () => {
    const project = await createProject("cc");
    const saved = await admin("PUT", `/projects/${project.id}/cc-list`, {
      emails: ["Lead@Acme.test", "lead@acme.test", "oncall@acme.test"],
    });
    expect(saved.status).toBe(200);
    expect(adminProjectSchema.parse(await saved.json()).ccList).toEqual([
      "lead@acme.test",
      "oncall@acme.test",
    ]);
    const listed = z
      .array(adminProjectSchema)
      .parse(await (await admin("GET", "/projects")).json());
    expect(listed.find((row) => row.id === project.id)?.ccList).toEqual([
      "lead@acme.test",
      "oncall@acme.test",
    ]);
    expect(
      (
        await admin("PUT", `/projects/${project.id}/cc-list`, {
          emails: ["bad"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin("PUT", `/projects/${crypto.randomUUID()}/cc-list`, {
          emails: [],
        })
      ).status,
    ).toBe(404);
    expect(
      (await admin("PUT", "/projects/nope/cc-list", { emails: [] })).status,
    ).toBe(404);
  });

  test("mints a key shown once, masks it afterwards, and revokes it", async () => {
    const project = await createProject("keys");
    const minted = mintedKeySchema.parse(
      await (await admin("POST", `/projects/${project.id}/keys`)).json(),
    );
    expect(minted.key.startsWith("pk_")).toBe(true);
    expect(minted.masked).not.toBe(minted.key);
    const listed = await (await admin("GET", "/projects")).text();
    expect(listed).not.toContain(minted.key);
    const intake = await harness.app.request("/v1/requests", {
      headers: {
        "X-Support-Key": minted.key,
        "X-Support-User": "a".repeat(64),
      },
    });
    expect(intake.status).toBe(200);
    const revoked = await admin(
      "POST",
      `/projects/${project.id}/keys/${minted.id}/revoke`,
    );
    expect(revoked.status).toBe(200);
    const after = adminProjectSchema.parse(await revoked.json());
    expect(after.keys[0]?.revokedAt).not.toBeNull();
    const denied = await harness.app.request("/v1/requests", {
      headers: {
        "X-Support-Key": minted.key,
        "X-Support-User": "a".repeat(64),
      },
    });
    expect(denied.status).toBe(401);
    expect(
      (await admin("POST", `/projects/${project.id}/keys/${minted.id}/revoke`))
        .status,
    ).toBe(404);
    expect(
      (await admin("POST", `/projects/${crypto.randomUUID()}/keys`)).status,
    ).toBe(404);
    expect((await admin("POST", "/projects/nope/keys")).status).toBe(404);
    expect(
      (await admin("POST", "/projects/nope/keys/nope/revoke")).status,
    ).toBe(404);
  });

  test("every settings mutation appends a typed audit event with the actor", async () => {
    const project = await createProject("audit");
    await admin("PATCH", `/projects/${project.id}`, { name: "Audited" });
    await admin("PUT", `/projects/${project.id}/cc-list`, {
      emails: ["a@acme.test"],
    });
    const minted = mintedKeySchema.parse(
      await (await admin("POST", `/projects/${project.id}/keys`)).json(),
    );
    await admin("POST", `/projects/${project.id}/keys/${minted.id}/revoke`);
    const rows = await harness.db
      .select()
      .from(events)
      .where(eq(events.channelKey, `${clientSlug}:audit`))
      .orderBy(events.seq);
    expect(rows.map((row) => row.type)).toEqual([
      "admin.project.created",
      "admin.project.updated",
      "admin.cc_list.updated",
      "admin.key.minted",
      "admin.key.revoked",
    ]);
    for (const row of rows) {
      expect(row.payload).toMatchObject({
        actor: { sub: "staff-1", email: "ada@pressw.test" },
      });
    }
    expect(JSON.stringify(rows)).not.toContain(minted.key);
  });
});

describe("admin integrations", () => {
  test("A18: a saved Linear key lives only in Secrets Manager", async () => {
    const secret = `lin_api_${crypto.randomUUID().replaceAll("-", "")}`;
    const captured: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (name) =>
        spyOn(console, name).mockImplementation((...args: unknown[]) => {
          captured.push(args.map((arg) => JSON.stringify(arg)).join(" "));
        }),
    );

    const before = await admin("GET", "/integrations");
    const beforeBody = z
      .array(integrationStatusSchema)
      .parse(await before.json());
    expect(beforeBody.every((status) => !status.configured)).toBe(true);

    const save = await admin("PUT", "/integrations/linear_api_key", {
      value: secret,
    });
    const saveText = await save.text();
    const after = await (await admin("GET", "/integrations")).text();
    const project = await (await admin("GET", "/projects")).text();
    const requests = await (await admin("GET", "/requests")).text();
    for (const spy of spies) spy.mockRestore();

    expect(save.status).toBe(200);
    const status = integrationStatusSchema.parse(JSON.parse(saveText));
    expect(status).toMatchObject({
      kind: "linear_api_key",
      configured: true,
      updatedBy: "ada@pressw.test",
    });
    expect(status.updatedAt).not.toBeNull();

    const stored = await sm.send(
      new GetSecretValueCommand({
        SecretId: secretId(scope, "linear-api-key"),
      }),
    );
    expect(stored.SecretString).toBe(secret);

    for (const body of [saveText, after, project, requests]) {
      expect(body).not.toContain(secret);
    }
    const afterStatuses = z
      .array(integrationStatusSchema)
      .parse(JSON.parse(after));
    expect(
      afterStatuses.find((row) => row.kind === "linear_api_key")?.configured,
    ).toBe(true);
    expect(Object.keys(afterStatuses[0] ?? {}).sort()).toEqual([
      "configured",
      "kind",
      "label",
      "updatedAt",
      "updatedBy",
    ]);

    const dump = await dumpDatabase();
    expect(["pg_dump", "sql"]).toContain(dump.method);
    expect(dump.text.length).toBeGreaterThan(1000);
    expect(dump.text).not.toContain(secret);
    expect(dump.text).toContain(secretId(scope, "linear-api-key"));

    expect(captured.join("\n")).not.toContain(secret);

    const eventRows = await harness.db
      .select()
      .from(events)
      .where(eq(events.type, "admin.integration.updated"));
    expect(JSON.stringify(eventRows)).not.toContain(secret);
    expect(
      eventRows.some(
        (row) =>
          (row.payload as { kind?: string }).kind === "linear_api_key" &&
          (row.payload as { scope?: string }).scope === scope,
      ),
    ).toBe(true);
  });

  test("replacing a secret updates the value and the metadata", async () => {
    const first = `tsk_${crypto.randomUUID()}`;
    const second = `tsk_${crypto.randomUUID()}`;
    await admin("PUT", "/integrations/typesafe_api_key", { value: first });
    await admin("PUT", "/integrations/typesafe_api_key", { value: second });
    const stored = await sm.send(
      new GetSecretValueCommand({
        SecretId: secretId(scope, "typesafe-api-key"),
      }),
    );
    expect(stored.SecretString).toBe(second);
    const rows = await harness.db
      .select()
      .from(integrations)
      .where(eq(integrations.scope, scope));
    expect(rows.filter((row) => row.kind === "typesafe_api_key")).toHaveLength(
      1,
    );
  });

  test("a body that is not valid never reaches logs or responses", async () => {
    const secret = `whsec_${crypto.randomUUID()}`;
    const captured: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((name) =>
      spyOn(console, name).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(" "));
      }),
    );
    const broken = await harness.app.request(
      "/admin/integrations/linear_webhook_secret",
      {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: `{"value": ${secret}`,
      },
    );
    const wrong = await admin("PUT", "/integrations/linear_webhook_secret", {
      value: 42,
      extra: secret,
    });
    for (const spy of spies) spy.mockRestore();
    expect(broken.status).toBe(400);
    expect(wrong.status).toBe(400);
    expect(await broken.text()).not.toContain(secret);
    expect(captured.join("\n")).not.toContain(secret);
  });

  test("returns 404 for an unknown kind and 413 for an oversized body", async () => {
    expect(
      (await admin("PUT", "/integrations/other", { value: "x" })).status,
    ).toBe(404);
    const large = await admin("PUT", "/integrations/linear_api_key", {
      value: "x".repeat(4000),
    });
    expect(large.status).toBe(413);
  });

  test("reports a secret store failure without leaking the value or saving a reference", async () => {
    const failing = await createHarness({
      config: {
        auth: idp.authConfig(),
        admin: { maxBodyBytes: 2048, mutationsPerWindow: 1000 },
        secretsScope: `${scope}-fail`,
      },
      deps: {
        secretWriter: {
          put: async () => {
            throw new Error("boom");
          },
        },
      },
    });
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await failing.app.request(
        "/admin/integrations/linear_api_key",
        {
          method: "PUT",
          headers: { ...bearer, "Content-Type": "application/json" },
          body: JSON.stringify({ value: "never-stored" }),
        },
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "secret_store_unavailable",
      });
      const rows = await failing.db
        .select()
        .from(integrations)
        .where(like(integrations.scope, `${scope}-fail`));
      expect(rows).toHaveLength(0);
    } finally {
      quiet.mockRestore();
      await failing.close();
    }
  });

  test("unhandled failures return a generic error and log no detail", async () => {
    const broken = await createHarness({
      config: { auth: idp.authConfig() },
      deps: {
        storage: {
          put: async () => {},
          get: async () => {
            throw new Error("storage detail with sk-secret");
          },
        },
      },
    });
    const logged: string[] = [];
    const quiet = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      },
    );
    try {
      const who = await broken.tenant("ivy@acme.test");
      const created = await broken.call(
        who,
        "POST",
        "/requests",
        form("file", [
          { name: "a.log", bytes: fixtures.text("x"), type: "text/plain" },
        ]),
      );
      expect(created.status).toBe(201);
      const [file] = await broken.db.select().from(attachments);
      const response = await broken.app.request(
        `/admin/attachments/${file?.id}`,
        { headers: bearer },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
    } finally {
      quiet.mockRestore();
      await broken.close();
    }
    expect(logged.join("")).not.toContain("sk-secret");
  });
});

describe("admin rate limit", () => {
  test("returns 429 with Retry-After after the mutation budget", async () => {
    const limited = await createHarness({
      config: {
        auth: idp.authConfig(),
        admin: { maxBodyBytes: 2048, mutationsPerWindow: 2 },
      },
      rateLimit: { windowSeconds: 3600 },
    });
    const staffToken = await idp.token({ claims: { sub: `rl-${scope}` } });
    const call = () =>
      limited.app.request("/admin/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${staffToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
    try {
      expect((await call()).status).toBe(400);
      expect((await call()).status).toBe(400);
      const third = await call();
      expect(third.status).toBe(429);
      expect(third.headers.get("Retry-After")).not.toBeNull();
      const read = await limited.app.request("/admin/me", {
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      expect(read.status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
