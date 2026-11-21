import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StaffIdentity } from "@pw-support/contracts";
import { eq } from "drizzle-orm";
import {
  closeDb,
  createAdminProject,
  createDb,
  decodeCursor,
  ensureProject,
  events,
  findProjectByKey,
  getAdminAttachment,
  getAdminProject,
  getAdminRequestDetail,
  getIntegration,
  inboundComments,
  listAdminProjects,
  listAdminRequests,
  listFlaggedReplies,
  listIntegrations,
  messages,
  migrate,
  mintProjectKey,
  persistInboundRequest,
  projects,
  recordAttachment,
  recordAttachmentRejection,
  recordIntegration,
  recordJudgments,
  replies,
  revokeProjectKey,
  setProjectCcList,
  triageJobs,
  updateAdminProject,
  upsertCustomer,
} from "./index";

const db = createDb();
const slug = `acme-admin-${crypto.randomUUID().slice(0, 8)}`;
const actor: StaffIdentity = {
  sub: "staff-1",
  email: "ada@pressw.test",
  name: "Ada",
};

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.clientSlug, slug));
  await closeDb(db);
});

async function seedRequest(projectSlug: string, body: string) {
  const { project } = await ensureProject(db, {
    clientSlug: slug,
    projectSlug,
    name: projectSlug,
  });
  const customer = await upsertCustomer(db, project.id, "c".repeat(64));
  const created = await persistInboundRequest(db, {
    scope: { project, customer },
    body,
  });
  return { project, customer, ...created };
}

async function seedReply(
  requestId: string,
  fields: Partial<typeof replies.$inferInsert> = {},
) {
  const commentId = `c-${crypto.randomUUID()}`;
  const [inbound] = await db
    .insert(inboundComments)
    .values({
      commentId,
      issueId: "issue-1",
      body: "@external hello",
      requestId,
      status: "processed",
    })
    .returning();
  const status = fields.status ?? "sent";
  const [sent] =
    status === "sent"
      ? await db
          .insert(messages)
          .values({
            requestId,
            body: "hello",
            originChannel: "linear",
            author: "staff",
            audience: "external",
          })
          .returning()
      : [];
  const [row] = await db
    .insert(replies)
    .values({
      requestId,
      inboundCommentId: (inbound as NonNullable<typeof inbound>).id,
      threadRootId: commentId,
      body: "hello",
      status,
      messageId: sent?.id,
      sentAt: sent ? new Date() : undefined,
      wordingScore: 4,
      ...fields,
    })
    .returning();
  return row as NonNullable<typeof row>;
}

describe("admin projects and keys", () => {
  test("creates a project once, appends an event, and refuses a duplicate", async () => {
    const created = await createAdminProject(
      db,
      {
        clientSlug: slug,
        projectSlug: "create",
        name: "Create",
        linearTeamId: "team-1",
      },
      actor,
    );
    expect(created?.linearTeamId).toBe("team-1");
    const again = await createAdminProject(
      db,
      { clientSlug: slug, projectSlug: "create", name: "Again" },
      actor,
    );
    expect(again).toBeNull();
    const rows = await db
      .select()
      .from(events)
      .where(eq(events.channelKey, `${slug}:create`));
    expect(rows.map((row) => row.type)).toEqual(["admin.project.created"]);
    expect(rows[0]?.payload).toMatchObject({
      actor: { sub: "staff-1", email: "ada@pressw.test" },
    });
  });

  test("updates the name and the Linear team", async () => {
    const created = await createAdminProject(
      db,
      { clientSlug: slug, projectSlug: "update", name: "Before" },
      actor,
    );
    const updated = await updateAdminProject(
      db,
      created?.id as string,
      { name: "After", linearTeamId: "team-2" },
      actor,
    );
    expect(updated).toMatchObject({ name: "After", linearTeamId: "team-2" });
    const cleared = await updateAdminProject(
      db,
      created?.id as string,
      { linearTeamId: null },
      actor,
    );
    expect(cleared?.linearTeamId).toBeNull();
    expect(
      await updateAdminProject(db, crypto.randomUUID(), { name: "x" }, actor),
    ).toBeNull();
  });

  test("A29: the cc list persists on the project", async () => {
    const created = await createAdminProject(
      db,
      { clientSlug: slug, projectSlug: "cc", name: "CC" },
      actor,
    );
    await setProjectCcList(
      db,
      created?.id as string,
      ["a@acme.test", "b@acme.test"],
      actor,
    );
    const loaded = await getAdminProject(db, created?.id as string);
    expect(loaded?.project.severeCcEmails).toEqual([
      "a@acme.test",
      "b@acme.test",
    ]);
    expect(
      await setProjectCcList(db, crypto.randomUUID(), [], actor),
    ).toBeNull();
  });

  test("mints a key that authenticates and revokes it once", async () => {
    const created = await createAdminProject(
      db,
      { clientSlug: slug, projectSlug: "keys", name: "Keys" },
      actor,
    );
    const projectId = created?.id as string;
    const minted = await mintProjectKey(db, projectId, actor);
    expect(minted?.key.startsWith("pk_")).toBe(true);
    expect(
      (await findProjectByKey(db, minted?.key as string))?.project.id,
    ).toBe(projectId);
    expect(
      await revokeProjectKey(db, projectId, minted?.id as string, actor),
    ).toBe(true);
    expect(
      await revokeProjectKey(db, projectId, minted?.id as string, actor),
    ).toBe(false);
    expect(await findProjectByKey(db, minted?.key as string)).toBeNull();
    expect(await mintProjectKey(db, crypto.randomUUID(), actor)).toBeNull();
    expect(
      await revokeProjectKey(
        db,
        crypto.randomUUID(),
        minted?.id as string,
        actor,
      ),
    ).toBe(false);
    const listed = (await listAdminProjects(db)).find(
      (row) => row.project.id === projectId,
    );
    expect(listed?.keys[0]?.revokedAt).not.toBeNull();
    expect(await getAdminProject(db, crypto.randomUUID())).toBeNull();
  });
});

describe("admin integrations", () => {
  test("records a reference only and upserts on the second save", async () => {
    const scope = `t-${crypto.randomUUID().slice(0, 8)}`;
    const first = await recordIntegration(
      db,
      {
        scope,
        kind: "linear_api_key",
        secretRef: `pw-support/${scope}/linear-api-key`,
      },
      actor,
    );
    expect(first.updatedBy).toBe("ada@pressw.test");
    await recordIntegration(
      db,
      {
        scope,
        kind: "linear_api_key",
        secretRef: `pw-support/${scope}/linear-api-key`,
      },
      { sub: "staff-2", email: null, name: null },
    );
    const rows = await listIntegrations(db, scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedBy).toBe("staff-2");
    expect(
      (await getIntegration(db, scope, "linear_api_key"))?.secretRef,
    ).toContain("linear-api-key");
    expect(await getIntegration(db, scope, "typesafe_api_key")).toBeNull();
  });

  test("the table refuses a reference outside the secrets prefix", async () => {
    await expect(
      recordIntegration(
        db,
        { scope: "x", kind: "linear_api_key", secretRef: "lin_api_value" },
        actor,
      ),
    ).rejects.toThrow();
  });
});

describe("admin requests", () => {
  test("lists newest first, filters, and pages with a cursor", async () => {
    const first = await seedRequest("list", "first request");
    await seedRequest("list", "second request");
    await seedRequest("list", "third request");
    const projectId = first.project.id;
    const page = await listAdminRequests(db, { projectId, limit: 2 });
    expect(page.rows.map((row) => row.preview)).toEqual([
      "third request",
      "second request",
    ]);
    expect(page.nextCursor).not.toBeNull();
    const next = await listAdminRequests(db, {
      projectId,
      limit: 2,
      cursor: page.nextCursor as string,
    });
    expect(next.rows.map((row) => row.preview)).toEqual(["first request"]);
    expect(next.nextCursor).toBeNull();
    const none = await listAdminRequests(db, {
      projectId,
      limit: 5,
      status: "closed",
    });
    expect(none.rows).toHaveLength(0);
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(
      (await listAdminRequests(db, { projectId, limit: 5, cursor: "bogus" }))
        .rows,
    ).toHaveLength(3);
  });

  test("acknowledged_at is the first staff Linear comment or external reply", async () => {
    const seeded = await seedRequest("ack", "needs a reply");
    const projectId = seeded.project.id;
    const before = await listAdminRequests(db, { projectId, limit: 5 });
    expect(before.rows[0]?.acknowledgedAt).toBeNull();
    await db.insert(messages).values({
      requestId: seeded.request.id,
      body: "customer follow-up",
      originChannel: "widget",
      author: "customer",
      audience: "external",
    });
    await db.insert(messages).values({
      requestId: seeded.request.id,
      body: "slack internal note",
      originChannel: "slack",
      author: "staff",
      audience: "internal",
    });
    const unchanged = await listAdminRequests(db, { projectId, limit: 5 });
    expect(unchanged.rows[0]?.acknowledgedAt).toBeNull();
    const [staff] = await db
      .insert(messages)
      .values({
        requestId: seeded.request.id,
        body: "internal linear comment",
        originChannel: "linear",
        author: "staff",
        audience: "internal",
      })
      .returning();
    await db.insert(messages).values({
      requestId: seeded.request.id,
      body: "later external reply",
      originChannel: "slack",
      author: "staff",
      audience: "external",
    });
    const after = await listAdminRequests(db, { projectId, limit: 5 });
    expect(after.rows[0]?.acknowledgedAt?.getTime()).toBe(
      staff?.createdAt.getTime(),
    );
  });

  test("filters by reply flags and human triage and reports them", async () => {
    const seeded = await seedRequest("flags", "flag me");
    const other = await seedRequest("flags", "plain");
    const quiet = await seedRequest("flags", "quiet");
    const projectId = seeded.project.id;
    await seedReply(seeded.request.id, { flagged: true, wordingScore: 2.5 });
    await seedReply(other.request.id, {
      status: "held",
      wordingScore: 1,
      holdReason: "wording_low",
      heldAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await seedReply(quiet.request.id);
    const flagged = await listAdminRequests(db, {
      projectId,
      limit: 10,
      flaggedReplies: true,
    });
    expect(flagged.rows.map((row) => row.id).sort()).toEqual(
      [seeded.request.id, other.request.id].sort(),
    );
    const real = await listFlaggedReplies(db, { projectId });
    expect(real.map((row) => row.reply.requestId)).toEqual([seeded.request.id]);
    const seededRow = flagged.rows.find((row) => row.id === seeded.request.id);
    expect(seededRow).toMatchObject({
      flaggedReplies: true,
      heldReplies: false,
    });
    const heldRow = flagged.rows.find((row) => row.id === other.request.id);
    expect(heldRow).toMatchObject({ flaggedReplies: false, heldReplies: true });
    const unflagged = await listAdminRequests(db, {
      projectId,
      limit: 10,
      flaggedReplies: false,
    });
    expect(unflagged.rows.map((row) => row.id)).toEqual([quiet.request.id]);
    await db
      .update(triageJobs)
      .set({ status: "completed", outcome: "human_triage" })
      .where(eq(triageJobs.id, seeded.job.id));
    const human = await listAdminRequests(db, {
      projectId,
      limit: 10,
      needsHuman: true,
    });
    const notHuman = await listAdminRequests(db, {
      projectId,
      limit: 10,
      needsHuman: false,
    });
    expect(human.rows.map((row) => row.id)).toEqual([seeded.request.id]);
    expect(human.rows[0]?.needsHumanTriage).toBe(true);
    expect(notHuman.rows.map((row) => row.id).sort()).toEqual(
      [other.request.id, quiet.request.id].sort(),
    );
  });

  test("a lapsed hold stops counting as held, and detail lists every reply state", async () => {
    const seeded = await seedRequest("lapsed", "lapsed hold");
    const soon = new Date(Date.now() - 1000);
    await seedReply(seeded.request.id, {
      status: "held",
      wordingScore: 0.5,
      holdReason: "wording_low",
      heldAt: soon,
      expiresAt: soon,
      warningCommentId: "w-1",
    });
    await seedReply(seeded.request.id, {
      status: "cancelled",
      cancelReason: "edited",
      wordingScore: 1,
    });
    const row = await listAdminRequests(db, {
      projectId: seeded.project.id,
      limit: 5,
    });
    expect(row.rows[0]).toMatchObject({
      flaggedReplies: false,
      heldReplies: false,
    });
    const filtered = await listAdminRequests(db, {
      projectId: seeded.project.id,
      limit: 5,
      flaggedReplies: true,
    });
    expect(filtered.rows).toHaveLength(0);
    const detail = await getAdminRequestDetail(db, seeded.request.id);
    expect(detail?.replies.map((reply) => reply.status)).toEqual([
      "held",
      "cancelled",
    ]);
  });

  test("returns the full detail and the admin attachment", async () => {
    const seeded = await seedRequest("detail", "detail request");
    const rejectionMessage = seeded.message;
    const file = await recordAttachment(db, {
      messageId: seeded.message.id,
      filename: "log.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      storageKey: "k/log.txt",
      sha256: "a".repeat(64),
    });
    await recordAttachmentRejection(db, {
      message: rejectionMessage,
      request: seeded.request,
      filename: "bad.exe",
      sizeBytes: 9,
      reason: "executable",
    });
    await recordJudgments(db, [
      {
        requestId: seeded.request.id,
        kind: "injection",
        subject: "secret customer text",
        score: 0.1,
        threshold: 0.5,
        flagged: false,
        raw: {},
      },
    ]);
    const detail = await getAdminRequestDetail(db, seeded.request.id);
    expect(detail?.messages[0]?.attachments[0]?.filename).toBe("log.txt");
    expect(detail?.rejections[0]?.reason).toBe("executable");
    expect(detail?.events.map((event) => event.type)).toContain(
      "request.created",
    );
    expect(detail?.judgments).toHaveLength(1);
    expect(detail?.job?.status).toBe("open");
    expect((await getAdminAttachment(db, file.id))?.storageKey).toBe(
      "k/log.txt",
    );
    expect(await getAdminAttachment(db, crypto.randomUUID())).toBeNull();
    expect(await getAdminRequestDetail(db, crypto.randomUUID())).toBeNull();
  });
});
