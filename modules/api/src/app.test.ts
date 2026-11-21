import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  intakeResultSchema,
  requestListSchema,
  threadSchema,
} from "@pw-support/contracts";
import {
  attachmentRejections,
  attachments,
  events,
  messages,
  projectKeys,
  requests,
} from "@pw-support/db";
import { and, eq } from "drizzle-orm";
import { fixtures } from "./testing/fixtures";
import { createHarness, form } from "./testing/harness";

const harness = await createHarness();
const { app, db, call, tenant, listKeys } = harness;

afterAll(async () => {
  await harness.close();
});

async function eventsFor(requestId: string) {
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.requestId, requestId))
    .orderBy(events.seq);
  return rows.map((row) => row.type);
}

async function submit(
  who: Awaited<ReturnType<typeof tenant>>,
  text: string,
  files: Parameters<typeof form>[1] = [],
) {
  const response = await call(who, "POST", "/requests", form(text, files));
  return {
    response,
    body:
      response.status === 201
        ? intakeResultSchema.parse(await response.clone().json())
        : null,
  };
}

describe("health and CORS", () => {
  test("GET /health returns ok without credentials", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("an unknown route returns 404", async () => {
    expect((await app.request("/missing")).status).toBe(404);
  });

  test("preflight from any origin is allowed with the support headers", async () => {
    const response = await app.request("/v1/requests", {
      method: "OPTIONS",
      headers: {
        Origin: "https://customer.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-support-key,x-support-user",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-Support-Key",
    );
  });

  test("error responses carry the CORS header", async () => {
    const response = await app.request("/v1/requests", {
      headers: { Origin: "https://customer.example" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("identity", () => {
  test("a missing or unknown key returns 401", async () => {
    const who = await tenant();
    const missing = await app.request("/v1/requests", {
      headers: { "X-Support-User": who.hashedId },
    });
    const unknown = await app.request("/v1/requests", {
      headers: { "X-Support-Key": "pk_nope", "X-Support-User": who.hashedId },
    });
    expect(missing.status).toBe(401);
    expect(unknown.status).toBe(401);
  });

  test("a revoked key returns 401", async () => {
    const who = await tenant();
    expect((await call(who, "GET", "/requests")).status).toBe(200);
    await db
      .update(projectKeys)
      .set({ revokedAt: new Date() })
      .where(eq(projectKeys.key, who.projectKey));
    expect((await call(who, "GET", "/requests")).status).toBe(401);
  });

  test("a malformed hashed id returns 400", async () => {
    const who = await tenant();
    for (const bad of ["", "ABC", "a".repeat(63), "A".repeat(64)]) {
      const response = await app.request("/v1/requests", {
        headers: { "X-Support-Key": who.projectKey, "X-Support-User": bad },
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("POST /v1/requests", () => {
  test("A2: request with text and two attachments persists request, files, and request.created", async () => {
    const who = await tenant();
    const { response, body } = await submit(who, "My export fails", [
      { name: "screenshot.png", bytes: fixtures.png(), type: "image/png" },
      { name: "app.log", bytes: fixtures.text("boom\n"), type: "text/plain" },
    ]);
    expect(response.status).toBe(201);
    expect(body?.files).toEqual([
      { filename: "screenshot.png", status: "stored" },
      { filename: "app.log", status: "stored" },
    ]);
    const requestId = body?.requestId ?? "";
    const [request] = await db
      .select()
      .from(requests)
      .where(eq(requests.id, requestId));
    expect(request?.projectId).toBe(who.projectId);
    const stored = await db
      .select()
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(eq(messages.requestId, requestId));
    expect(stored.map((row) => row.attachments.filename).sort()).toEqual([
      "app.log",
      "screenshot.png",
    ]);
    for (const row of stored) {
      expect(row.attachments.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.attachments.storageKey).toStartWith(
        `${who.projectId}/${requestId}/`,
      );
    }
    expect(await listKeys(`${who.projectId}/${requestId}/`)).toHaveLength(2);
    expect(await eventsFor(requestId)).toEqual(["request.created"]);
    const [message] = await db
      .select()
      .from(messages)
      .where(eq(messages.requestId, requestId));
    expect(message).toMatchObject({
      body: "My export fails",
      originChannel: "widget",
      author: "customer",
      audience: "external",
      bodyFlagged: false,
    });
  });

  test("a request without files succeeds", async () => {
    const who = await tenant();
    const { body } = await submit(who, "just text");
    expect(body?.files).toEqual([]);
    expect(body?.message.body).toBe("just text");
  });

  test("a message with markup stays stored, is flagged, and returns sanitized text", async () => {
    const who = await tenant();
    const raw = "help <script>alert(1)</script><b>now</b>";
    const { body } = await submit(who, raw);
    expect(body?.message.body).toBe("help now");
    expect(body?.message.flagged).toBe(true);
    const [stored] = await db
      .select()
      .from(messages)
      .where(eq(messages.requestId, body?.requestId ?? ""));
    expect(stored?.body).toBe(raw);
    expect(stored?.sanitizedBody).toBe("help now");
    expect(stored?.bodyFlagged).toBe(true);
    expect(await eventsFor(body?.requestId ?? "")).toEqual([
      "request.created",
      "message.flagged",
    ]);
  });

  test("an over-long message stays stored and is flagged", async () => {
    const who = await tenant();
    const { body } = await submit(who, "x".repeat(10_050));
    expect(body?.message.flagged).toBe(true);
    expect(body?.message.body).toHaveLength(10_000);
  });

  test("A4: a renamed executable is rejected, recorded, and never stored in S3", async () => {
    const who = await tenant();
    const { body } = await submit(who, "see invoice", [
      { name: "invoice.pdf", bytes: fixtures.elf(), type: "application/pdf" },
      { name: "setup.png", bytes: fixtures.pe(), type: "image/png" },
      { name: "ok.png", bytes: fixtures.png(), type: "image/png" },
    ]);
    expect(body?.files).toEqual([
      { filename: "invoice.pdf", status: "rejected", reason: "executable" },
      { filename: "setup.png", status: "rejected", reason: "executable" },
      { filename: "ok.png", status: "stored" },
    ]);
    const requestId = body?.requestId ?? "";
    expect(await listKeys(`${who.projectId}/${requestId}/`)).toHaveLength(1);
    const rejections = await db
      .select()
      .from(attachmentRejections)
      .where(eq(attachmentRejections.messageId, body?.message.id ?? ""));
    expect(rejections.map((row) => row.reason)).toEqual([
      "executable",
      "executable",
    ]);
    const types = await eventsFor(requestId);
    expect(types.filter((type) => type === "attachment.rejected")).toHaveLength(
      2,
    );
  });

  test("A4: a 26 MB file is rejected as too_large", async () => {
    const who = await tenant();
    const { body } = await submit(who, "big", [
      { name: "huge.png", bytes: fixtures.megabytes(26), type: "image/png" },
    ]);
    expect(body?.files).toEqual([
      { filename: "huge.png", status: "rejected", reason: "too_large" },
    ]);
    expect(await listKeys(`${who.projectId}/${body?.requestId}/`)).toHaveLength(
      0,
    );
  });

  test("A4: an eleventh file is rejected as too_many_files", async () => {
    const who = await tenant();
    const files = Array.from({ length: 11 }, (_, index) => ({
      name: `f${index}.txt`,
      bytes: fixtures.text(`line ${index}`),
    }));
    const { body } = await submit(who, "many", files);
    const results = body?.files ?? [];
    expect(results.slice(0, 10).every((r) => r.status === "stored")).toBe(true);
    expect(results[10]).toEqual({
      filename: "f10.txt",
      status: "rejected",
      reason: "too_many_files",
    });
    expect(await listKeys(`${who.projectId}/${body?.requestId}/`)).toHaveLength(
      10,
    );
  });

  test("A4: mp4, mov, and webm video are rejected", async () => {
    const who = await tenant();
    const { body } = await submit(who, "video", [
      { name: "clip.mp4", bytes: fixtures.mp4(), type: "video/mp4" },
      { name: "clip.mov", bytes: fixtures.mov(), type: "video/quicktime" },
      { name: "clip.webm", bytes: fixtures.webm(), type: "video/webm" },
    ]);
    expect(body?.files.map((file) => file.reason)).toEqual([
      "video",
      "video",
      "video",
    ]);
  });

  test("an empty file is rejected as empty", async () => {
    const who = await tenant();
    const { body } = await submit(who, "empty", [
      { name: "e.txt", bytes: new Uint8Array() },
    ]);
    expect(body?.files[0]?.reason).toBe("empty");
  });

  test("a path in the filename is reduced to its base name", async () => {
    const who = await tenant();
    const { body } = await submit(who, "path", [
      { name: "../../etc/pass wd.txt", bytes: fixtures.text() },
    ]);
    expect(body?.files[0]?.filename).toBe("pass wd.txt");
  });

  test("a missing or blank text field returns 400", async () => {
    const who = await tenant();
    const missing = await call(who, "POST", "/requests", form(null));
    const blank = await call(who, "POST", "/requests", form("   "));
    expect(missing.status).toBe(400);
    expect(blank.status).toBe(400);
    const notForm = await app.request("/v1/requests", {
      method: "POST",
      headers: { ...who.headers, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(notForm.status).toBe(400);
  });

  test("a body above the limit returns 413", async () => {
    const small = await createHarness({ maxBodyBytes: 2048 });
    try {
      const who = await small.tenant();
      const response = await small.call(
        who,
        "POST",
        "/requests",
        form("x".repeat(5000)),
      );
      expect(response.status).toBe(413);
    } finally {
      await small.close();
    }
  });
});

describe("D7: persist before processing", () => {
  test("D7: when static-check processing throws, the request row and request.created event still exist", async () => {
    const failing = await createHarness({
      deps: {
        checks: {
          checkMessage: () => {
            throw new Error("checker down");
          },
          detectFile: () => ({ ok: false, reason: "executable" }),
        },
      },
    });
    try {
      const who = await failing.tenant();
      const response = await failing.call(
        who,
        "POST",
        "/requests",
        form("keep me", [{ name: "a.txt", bytes: fixtures.text() }]),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { requestId: string };
      const [request] = await failing.db
        .select()
        .from(requests)
        .where(eq(requests.id, body.requestId));
      expect(request?.id).toBe(body.requestId);
      const [message] = await failing.db
        .select()
        .from(messages)
        .where(eq(messages.requestId, body.requestId));
      expect(message?.body).toBe("keep me");
      const rows = await failing.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.requestId, body.requestId),
            eq(events.type, "request.created"),
          ),
        );
      expect(rows).toHaveLength(1);
    } finally {
      await failing.close();
    }
  });

  test("D7: when storage throws, the request and event persist and the file reports storage_failed", async () => {
    const broken = await createHarness({
      deps: {
        storage: {
          put: () => Promise.reject(new Error("s3 down")),
          get: () => Promise.reject(new Error("s3 down")),
        },
      },
    });
    try {
      const who = await broken.tenant();
      const response = await broken.call(
        who,
        "POST",
        "/requests",
        form("keep me", [{ name: "a.txt", bytes: fixtures.text() }]),
      );
      expect(response.status).toBe(201);
      const body = intakeResultSchema.parse(await response.json());
      expect(body.files).toEqual([
        { filename: "a.txt", status: "rejected", reason: "storage_failed" },
      ]);
      const types = (
        await broken.db
          .select()
          .from(events)
          .where(eq(events.requestId, body.requestId))
      ).map((row) => row.type);
      expect(types).toContain("request.created");
      expect(types).toContain("attachment.rejected");
    } finally {
      await broken.close();
    }
  });
});

describe("GET /v1/requests and threads", () => {
  test("lists the customer's requests newest first with previews", async () => {
    const who = await tenant();
    expect(
      requestListSchema.parse(
        await (await call(who, "GET", "/requests")).json(),
      ).requests,
    ).toEqual([]);
    const first = await submit(who, "first question");
    const second = await submit(who, "second question");
    const list = requestListSchema.parse(
      await (await call(who, "GET", "/requests")).json(),
    );
    expect(list.requests.map((r) => r.id)).toEqual([
      second.body?.requestId ?? "",
      first.body?.requestId ?? "",
    ]);
    expect(list.requests[0]?.lastMessage?.preview).toBe("second question");
    expect(list.requests[0]?.unreadCount).toBe(0);
  });

  test("the thread shows only customer-visible messages with attachment metadata", async () => {
    const who = await tenant();
    const { body } = await submit(who, "with file", [
      { name: "a.png", bytes: fixtures.png() },
    ]);
    const requestId = body?.requestId ?? "";
    await db.insert(messages).values([
      {
        requestId,
        body: "staff public reply",
        originChannel: "linear",
        author: "staff",
        audience: "external",
      },
      {
        requestId,
        body: "internal only",
        originChannel: "linear",
        author: "staff",
        audience: "internal",
      },
    ]);
    const thread = threadSchema.parse(
      await (await call(who, "GET", `/requests/${requestId}`)).json(),
    );
    expect(thread.messages.map((m) => m.body)).toEqual([
      "with file",
      "staff public reply",
    ]);
    expect(thread.messages[0]?.attachments[0]).toMatchObject({
      filename: "a.png",
      contentType: "image/png",
    });
    expect(thread.messages[1]).toMatchObject({
      author: "staff",
      originChannel: "linear",
    });
  });

  test("unread counts staff messages after the last read and clears on read", async () => {
    const who = await tenant();
    const { body } = await submit(who, "question");
    const requestId = body?.requestId ?? "";
    await db.insert(messages).values({
      requestId,
      body: "answer",
      originChannel: "slack",
      author: "staff",
      audience: "external",
    });
    const unread = async () =>
      requestListSchema.parse(
        await (await call(who, "GET", "/requests")).json(),
      ).requests[0]?.unreadCount;
    expect(await unread()).toBe(1);
    expect(
      (await call(who, "POST", `/requests/${requestId}/read`)).status,
    ).toBe(200);
    expect(await unread()).toBe(0);
    await db.insert(messages).values({
      requestId,
      body: "another",
      originChannel: "slack",
      author: "staff",
      audience: "external",
    });
    expect(await unread()).toBe(1);
  });

  test("unknown and malformed ids return 404", async () => {
    const who = await tenant();
    const missing = crypto.randomUUID();
    expect((await call(who, "GET", `/requests/${missing}`)).status).toBe(404);
    expect((await call(who, "GET", "/requests/not-a-uuid")).status).toBe(404);
    expect((await call(who, "POST", `/requests/${missing}/read`)).status).toBe(
      404,
    );
    expect((await call(who, "POST", "/requests/x/read")).status).toBe(404);
    expect(
      (await call(who, "POST", "/requests/x/messages", form("hi"))).status,
    ).toBe(404);
    expect((await call(who, "GET", "/attachments/x")).status).toBe(404);
    expect((await call(who, "GET", `/attachments/${missing}`)).status).toBe(
      404,
    );
  });
});

describe("POST /v1/requests/:id/messages", () => {
  test("a follow-up appends message.created and runs the same checks", async () => {
    const who = await tenant();
    const { body } = await submit(who, "question");
    const requestId = body?.requestId ?? "";
    const response = await call(
      who,
      "POST",
      `/requests/${requestId}/messages`,
      form("<i>more</i> detail", [
        { name: "more.png", bytes: fixtures.png() },
        { name: "bad.pdf", bytes: fixtures.elf() },
      ]),
    );
    expect(response.status).toBe(201);
    const result = intakeResultSchema.parse(await response.json());
    expect(result.message.body).toBe("more detail");
    expect(result.message.flagged).toBe(true);
    expect(result.files.map((file) => file.status)).toEqual([
      "stored",
      "rejected",
    ]);
    expect(await eventsFor(requestId)).toEqual([
      "request.created",
      "message.created",
      "message.flagged",
      "attachment.rejected",
    ]);
    const thread = threadSchema.parse(
      await (await call(who, "GET", `/requests/${requestId}`)).json(),
    );
    expect(thread.messages).toHaveLength(2);
  });

  test("a follow-up without text returns 400", async () => {
    const who = await tenant();
    const { body } = await submit(who, "question");
    const response = await call(
      who,
      "POST",
      `/requests/${body?.requestId}/messages`,
      form(""),
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /v1/attachments/:id", () => {
  test("streams the stored bytes with safe headers", async () => {
    const who = await tenant();
    const png = fixtures.png();
    const { body } = await submit(who, "file", [
      { name: "résumé shot.png", bytes: png },
    ]);
    const id = body?.message.attachments[0]?.id ?? "";
    const response = await call(who, "GET", `/attachments/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20shot.png",
    );
    const received = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(png));
  });

  test("a storage read failure returns 500 without leaking details", async () => {
    const broken = await createHarness({
      deps: {
        storage: {
          put: () => Promise.resolve(),
          get: () => Promise.reject(new Error("secret bucket detail")),
        },
      },
    });
    try {
      const who = await broken.tenant();
      const created = await broken.call(
        who,
        "POST",
        "/requests",
        form("f", [{ name: "a.txt", bytes: fixtures.text() }]),
      );
      const id =
        intakeResultSchema.parse(await created.json()).message.attachments[0]
          ?.id ?? "";
      const response = await broken.call(who, "GET", `/attachments/${id}`);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("secret bucket detail");
    } finally {
      await broken.close();
    }
  });
});

describe("A17: project isolation", () => {
  async function twoProjects() {
    const owner = await tenant("shared@acme.test");
    const intruderProject = await tenant("other@acme.test");
    const crossed = await harness.asTenant(
      intruderProject.projectId,
      intruderProject.projectKey,
      "shared@acme.test",
    );
    const impostor = {
      headers: {
        "X-Support-Key": intruderProject.projectKey,
        "X-Support-User": owner.hashedId,
      },
    };
    const { body } = await submit(owner, "private to project B", [
      { name: "secret.png", bytes: fixtures.png() },
    ]);
    return {
      impostor,
      crossed,
      requestId: body?.requestId ?? "",
      attachmentId: body?.message.attachments[0]?.id ?? "",
    };
  }

  test("A17: key A with a hashed ID from project B lists no requests", async () => {
    const { impostor, crossed } = await twoProjects();
    for (const who of [impostor, crossed]) {
      const list = requestListSchema.parse(
        await (await call(who, "GET", "/requests")).json(),
      );
      expect(list.requests).toEqual([]);
    }
  });

  test("A17: key A cannot read a project B thread", async () => {
    const { impostor, requestId } = await twoProjects();
    expect((await call(impostor, "GET", `/requests/${requestId}`)).status).toBe(
      404,
    );
  });

  test("A17: key A cannot post a follow-up to a project B request", async () => {
    const { impostor, requestId } = await twoProjects();
    const response = await call(
      impostor,
      "POST",
      `/requests/${requestId}/messages`,
      form("injected"),
    );
    expect(response.status).toBe(404);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.requestId, requestId));
    expect(rows).toHaveLength(1);
  });

  test("A17: key A cannot mark a project B thread read", async () => {
    const { impostor, requestId } = await twoProjects();
    expect(
      (await call(impostor, "POST", `/requests/${requestId}/read`)).status,
    ).toBe(404);
    const [row] = await db
      .select()
      .from(requests)
      .where(eq(requests.id, requestId));
    expect(row?.customerLastReadAt).toBeNull();
  });

  test("A17: key A cannot download a project B attachment", async () => {
    const { impostor, attachmentId } = await twoProjects();
    expect(
      (await call(impostor, "GET", `/attachments/${attachmentId}`)).status,
    ).toBe(404);
  });

  test("a second customer in the same project cannot read the first customer's thread", async () => {
    const owner = await tenant("one@acme.test");
    const other = await harness.asTenant(
      owner.projectId,
      owner.projectKey,
      "two@acme.test",
    );
    const { body } = await submit(owner, "mine", [
      { name: "a.png", bytes: fixtures.png() },
    ]);
    const requestId = body?.requestId ?? "";
    const attachmentId = body?.message.attachments[0]?.id ?? "";
    expect((await call(other, "GET", `/requests/${requestId}`)).status).toBe(
      404,
    );
    expect(
      (await call(other, "GET", `/attachments/${attachmentId}`)).status,
    ).toBe(404);
    expect(
      requestListSchema.parse(
        await (await call(other, "GET", "/requests")).json(),
      ).requests,
    ).toEqual([]);
  });
});

describe("rate limiting", () => {
  let limited: Awaited<ReturnType<typeof createHarness>>;

  beforeAll(async () => {
    limited = await createHarness({
      rateLimit: { perUser: 3, perKey: 5, windowSeconds: 3600 },
    });
  });

  afterAll(async () => {
    await limited.close();
  });

  test("the per-user limit returns 429 with Retry-After", async () => {
    const who = await limited.tenant("rate@acme.test");
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let index = 0; index < 4; index++) {
      const response = await limited.call(who, "GET", "/requests");
      statuses.push(response.status);
      retryAfter = response.headers.get("retry-after") ?? retryAfter;
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(3600);
  });

  test("the per-key limit applies across users of one project", async () => {
    const first = await limited.tenant("a@acme.test");
    const second = await limited.asTenant(
      first.projectId,
      first.projectKey,
      "b@acme.test",
    );
    const third = await limited.asTenant(
      first.projectId,
      first.projectKey,
      "c@acme.test",
    );
    const statuses: number[] = [];
    for (const who of [first, second, third, first, second, third]) {
      statuses.push((await limited.call(who, "GET", "/requests")).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  test("another project is not affected by a limited one", async () => {
    const noisy = await limited.tenant("noisy@acme.test");
    for (let index = 0; index < 4; index++) {
      await limited.call(noisy, "GET", "/requests");
    }
    const calm = await limited.tenant("noisy@acme.test");
    expect((await limited.call(calm, "GET", "/requests")).status).toBe(200);
  });
});
