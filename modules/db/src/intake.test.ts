import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  attachmentRejections,
  type CustomerScope,
  closeDb,
  createDb,
  ensureProject,
  events,
  findProjectByKey,
  generateProjectKey,
  getCustomerAttachment,
  getCustomerThread,
  hitRateLimit,
  listCustomerRequests,
  markThreadRead,
  messages,
  migrate,
  persistInboundMessage,
  persistInboundRequest,
  projectKeys,
  projects,
  recordAttachment,
  recordAttachmentRejection,
  recordMessageChecks,
  upsertCustomer,
} from "./index";

const db = createDb();
const slug = `acme-${crypto.randomUUID().slice(0, 8)}`;
const hashed = "b".repeat(64);

async function scopeFor(projectSlug: string, hashedId = hashed) {
  const { project, key } = await ensureProject(db, {
    clientSlug: slug,
    projectSlug,
    name: projectSlug,
  });
  const customer = await upsertCustomer(db, project.id, hashedId);
  return { scope: { project, customer } satisfies CustomerScope, key };
}

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.clientSlug, slug));
  await closeDb(db);
});

describe("projects", () => {
  test("ensureProject is idempotent and reuses the active key", async () => {
    const first = await ensureProject(db, {
      clientSlug: slug,
      projectSlug: "idem",
      name: "Idem",
    });
    const second = await ensureProject(db, {
      clientSlug: slug,
      projectSlug: "idem",
      name: "Idem",
    });
    expect(second.key).toBe(first.key);
    expect(second.project.id).toBe(first.project.id);
    expect(first.key).toStartWith("pk_");
  });

  test("ensureProject honors an explicit key for a new project", async () => {
    const key = `pk_test_${crypto.randomUUID()}`;
    const result = await ensureProject(db, {
      clientSlug: slug,
      projectSlug: "explicit",
      name: "Explicit",
      key,
    });
    expect(result.key).toBe(key);
  });

  test("findProjectByKey resolves active keys and skips revoked ones", async () => {
    const { project, key } = await ensureProject(db, {
      clientSlug: slug,
      projectSlug: "revoke",
      name: "Revoke",
    });
    expect((await findProjectByKey(db, key))?.project.id).toBe(project.id);
    await db
      .update(projectKeys)
      .set({ revokedAt: new Date() })
      .where(eq(projectKeys.key, key));
    expect(await findProjectByKey(db, key)).toBeNull();
    expect(await findProjectByKey(db, "missing")).toBeNull();
  });

  test("generateProjectKey returns distinct url-safe keys", () => {
    const a = generateProjectKey();
    expect(a).toMatch(/^pk_[A-Za-z0-9_-]{24}$/);
    expect(generateProjectKey()).not.toBe(a);
  });
});

describe("inbound persistence", () => {
  test("upsertCustomer returns the same customer for the same hash", async () => {
    const { scope } = await scopeFor("customers");
    const again = await upsertCustomer(db, scope.project.id, hashed);
    expect(again.id).toBe(scope.customer.id);
  });

  test("persistInboundRequest writes request, message, and request.created together", async () => {
    const { scope } = await scopeFor("inbound");
    const { request, message } = await persistInboundRequest(db, {
      scope,
      body: "help",
    });
    expect(request.channelKey).toBe(`${slug}:inbound:${hashed}`);
    expect(message.originChannel).toBe("widget");
    expect(message.author).toBe("customer");
    expect(message.audience).toBe("external");
    const stored = await db
      .select()
      .from(events)
      .where(eq(events.requestId, request.id));
    expect(stored.map((event) => event.type)).toEqual(["request.created"]);
    expect(stored[0]?.payload).toMatchObject({ messageId: message.id });
  });

  test("persistInboundMessage appends message.created and refuses foreign requests", async () => {
    const { scope } = await scopeFor("followup");
    const other = await scopeFor("followup-other");
    const { request } = await persistInboundRequest(db, { scope, body: "one" });
    const added = await persistInboundMessage(db, {
      scope,
      requestId: request.id,
      body: "two",
    });
    expect(added?.message.body).toBe("two");
    const foreign = await persistInboundMessage(db, {
      scope: other.scope,
      requestId: request.id,
      body: "intruder",
    });
    expect(foreign).toBeNull();
    const types = (
      await db.select().from(events).where(eq(events.requestId, request.id))
    ).map((event) => event.type);
    expect(types).toEqual(["request.created", "message.created"]);
  });

  test("recordMessageChecks stores the sanitized body and flags with an event", async () => {
    const { scope } = await scopeFor("checks");
    const { request, message } = await persistInboundRequest(db, {
      scope,
      body: "<b>hi</b>",
    });
    const updated = await recordMessageChecks(db, {
      message,
      request,
      sanitizedBody: "hi",
      flagged: true,
      reasons: ["markup"],
    });
    expect(updated.bodyFlagged).toBe(true);
    expect(updated.sanitizedBody).toBe("hi");
    expect(updated.body).toBe("<b>hi</b>");
    const clean = await recordMessageChecks(db, {
      message,
      request,
      sanitizedBody: "hi",
      flagged: false,
      reasons: [],
    });
    expect(clean.bodyFlagged).toBe(false);
    const flagged = (
      await db.select().from(events).where(eq(events.requestId, request.id))
    ).filter((event) => event.type === "message.flagged");
    expect(flagged).toHaveLength(1);
  });

  test("recordAttachmentRejection stores the reason and appends attachment.rejected", async () => {
    const { scope } = await scopeFor("reject");
    const { request, message } = await persistInboundRequest(db, {
      scope,
      body: "files",
    });
    await recordAttachmentRejection(db, {
      message,
      request,
      filename: "invoice.pdf",
      sizeBytes: 12,
      reason: "executable",
    });
    const rows = await db
      .select()
      .from(attachmentRejections)
      .where(eq(attachmentRejections.messageId, message.id));
    expect(rows[0]?.reason).toBe("executable");
    const event = (
      await db.select().from(events).where(eq(events.requestId, request.id))
    ).find((row) => row.type === "attachment.rejected");
    expect(event?.payload).toMatchObject({ reason: "executable" });
  });
});

describe("customer reads", () => {
  test("lists newest activity first with a preview and unread count", async () => {
    const { scope } = await scopeFor("list");
    expect(await listCustomerRequests(db, scope)).toEqual([]);
    const older = await persistInboundRequest(db, { scope, body: "older" });
    const newer = await persistInboundRequest(db, { scope, body: "newer" });
    await db.insert(messages).values([
      {
        requestId: older.request.id,
        body: "staff reply",
        originChannel: "linear",
        author: "staff",
        audience: "external",
      },
      {
        requestId: older.request.id,
        body: "internal note",
        originChannel: "linear",
        author: "staff",
        audience: "internal",
      },
    ]);
    const items = await listCustomerRequests(db, scope);
    expect(items.map((item) => item.request.id)).toEqual([
      newer.request.id,
      older.request.id,
    ]);
    const olderItem = items[1];
    expect(olderItem?.unreadCount).toBe(1);
    expect(olderItem?.lastMessage?.preview).toBe("staff reply");
    expect(olderItem?.lastMessage?.author).toBe("staff");
    expect(items[0]?.unreadCount).toBe(0);
  });

  test("markThreadRead clears unread and reports unknown requests", async () => {
    const { scope } = await scopeFor("read");
    const { request } = await persistInboundRequest(db, { scope, body: "q" });
    await db.insert(messages).values({
      requestId: request.id,
      body: "answer",
      originChannel: "slack",
      author: "staff",
      audience: "external",
    });
    expect((await listCustomerRequests(db, scope))[0]?.unreadCount).toBe(1);
    expect(await markThreadRead(db, scope, request.id)).toBe(true);
    expect((await listCustomerRequests(db, scope))[0]?.unreadCount).toBe(0);
    expect(await markThreadRead(db, scope, crypto.randomUUID())).toBe(false);
  });

  test("thread hides internal messages and attaches files per message", async () => {
    const { scope } = await scopeFor("thread");
    const { request, message } = await persistInboundRequest(db, {
      scope,
      body: "with file",
    });
    await db.insert(messages).values({
      requestId: request.id,
      body: "secret",
      originChannel: "linear",
      author: "staff",
      audience: "internal",
    });
    const file = await recordAttachment(db, {
      messageId: message.id,
      filename: "a.png",
      contentType: "image/png",
      sizeBytes: 3,
      storageKey: "k",
      sha256: "0".repeat(64),
    });
    const thread = await getCustomerThread(db, scope, request.id);
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]?.attachments[0]?.id).toBe(file.id);
    expect(await getCustomerThread(db, scope, crypto.randomUUID())).toBeNull();
  });

  test("an empty thread view has no files query result", async () => {
    const { scope } = await scopeFor("empty-thread");
    const { request } = await persistInboundRequest(db, { scope, body: "x" });
    await db.delete(messages).where(eq(messages.requestId, request.id));
    const thread = await getCustomerThread(db, scope, request.id);
    expect(thread?.messages).toEqual([]);
  });

  test("attachments resolve only inside the owning project and customer", async () => {
    const { scope } = await scopeFor("att");
    const other = await scopeFor("att-other");
    const { message } = await persistInboundRequest(db, { scope, body: "f" });
    const file = await recordAttachment(db, {
      messageId: message.id,
      filename: "a.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      storageKey: "k2",
      sha256: "1".repeat(64),
    });
    expect((await getCustomerAttachment(db, scope, file.id))?.id).toBe(file.id);
    expect(await getCustomerAttachment(db, other.scope, file.id)).toBeNull();
  });
});

describe("rate limits", () => {
  test("counts hits inside a window and resets in the next", async () => {
    const subject = crypto.randomUUID();
    const now = Date.UTC(2026, 0, 1, 0, 0, 10);
    const a = await hitRateLimit(db, {
      scope: "t",
      subject,
      windowSeconds: 60,
      now,
    });
    const b = await hitRateLimit(db, {
      scope: "t",
      subject,
      windowSeconds: 60,
      now: now + 1000,
    });
    const c = await hitRateLimit(db, {
      scope: "t",
      subject,
      windowSeconds: 60,
      now: now + 60_000,
    });
    expect([a.hits, b.hits, c.hits]).toEqual([1, 2, 1]);
    expect(a.retryAfterSeconds).toBe(50);
  });

  test("uses the current time by default", async () => {
    const result = await hitRateLimit(db, {
      scope: "t",
      subject: crypto.randomUUID(),
      windowSeconds: 60,
    });
    expect(result.hits).toBe(1);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});
