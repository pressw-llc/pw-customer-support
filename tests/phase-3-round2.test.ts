import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLinearAdapter } from "@pw-support/channels";
import {
  type CommentAction,
  commentWebhookPayload,
  deliverCommentWebhook,
  STUB_STAFF_ID,
  type StaffCommentInput,
  type StubComment,
  signLinearWebhook,
} from "@pw-support/channels/testing";
import {
  applyCommentChange,
  attachments,
  commentChanges,
  confirmHeldReply,
  events,
  getEventBySeq,
  persistInboundComment,
  recordAttachment,
  resolveOrphanComments,
  tickets,
} from "@pw-support/db";
import { handleWake } from "@pw-support/triage";
import { and, eq, sql } from "drizzle-orm";
import {
  createPhase3Harness,
  type Phase3Harness,
  WEBHOOK_SECRET,
} from "./phase-3-support";

let p: Phase3Harness;

beforeAll(async () => {
  p = await createPhase3Harness();
});

afterAll(async () => {
  await p.close();
});

type Scenario = Awaited<ReturnType<Phase3Harness["scenario"]>>;

const target = () => ({ url: p.webhookUrl, secret: WEBHOOK_SECRET });

async function deliver(comment: StubComment, action: CommentAction = "create") {
  return deliverCommentWebhook(target(), comment, { action });
}

async function post(payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const response = await fetch(p.webhookUrl, {
    keepalive: false,
    method: "POST",
    headers: {
      "Linear-Delivery": crypto.randomUUID(),
      "Linear-Signature": signLinearWebhook(WEBHOOK_SECRET, raw),
    },
    body: raw,
  });
  return (await response.json()) as Record<string, unknown>;
}

async function staff(
  s: Scenario,
  body: string,
  options: Omit<StaffCommentInput, "issueId" | "body"> = {},
) {
  const { comment, delivery } = await p.stub.staffComment({
    issueId: s.issueId,
    body,
    ...options,
  });
  if (options.deliver !== false) expect(delivery?.status).toBe(200);
  if (options.deliver !== false) await p.drain(s.requestId);
  return comment;
}

const bodiesOf = (t: Awaited<ReturnType<Phase3Harness["thread"]>>) =>
  t.messages.map((m) => m.body);

async function inboundOf(commentId: string) {
  return p.h.db.query.inboundComments.findFirst({
    where: (t, { eq: same }) => same(t.commentId, commentId),
  });
}

async function everyRowAsText(): Promise<string> {
  const names = await p.h.db.execute<{ table_name: string }>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'support' AND table_type = 'BASE TABLE'`,
  );
  const chunks: string[] = [];
  for (const { table_name } of names) {
    const rows = await p.h.db.execute<{ r: string }>(
      sql.raw(
        `SELECT row_to_json(t)::text AS r FROM support."${table_name}" t`,
      ),
    );
    for (const row of rows) chunks.push(row.r);
  }
  return chunks.join("\n");
}

async function ticketlessWithRace(
  during: (issueId: string) => Promise<void>,
  requestText = "Where is my invoice?",
) {
  const who = await p.h.tenant({ teamId: p.stub.teams[0]?.id });
  const submitted = await p.h.submit(who, requestText);
  p.h.clock.advance(61);
  await handleWake(p.h.deps, submitted.jobId);
  const racing = {
    ...p.linear,
    async createIssue(input: Parameters<typeof p.linear.createIssue>[0]) {
      const issue = await p.linear.createIssue(input);
      await during(issue.id);
      return issue;
    },
  };
  const racer = createLinearAdapter({
    db: p.h.db,
    linear: racing,
    now: p.h.clock.now,
  });
  const outcome = await racer.createTicketForRequest(submitted.requestId);
  expect(outcome.status).toBe("created");
  return { who, requestId: submitted.requestId };
}

describe("N3 a comment on an issue with no ticket stores no text", () => {
  test("an unrelated issue leaves no body and no author name in any table", async () => {
    const secretBody = "payroll spreadsheet is attached for Q3 review";
    const secretName = "Bob Unrelated";
    const ghost: StubComment = {
      id: crypto.randomUUID(),
      issueId: `issue-unrelated-${crypto.randomUUID()}`,
      body: secretBody,
      userId: STUB_STAFF_ID,
      userName: secretName,
      parentId: null,
    };
    expect((await deliver(ghost)).body).toContain("awaiting_ticket");
    const row = await inboundOf(ghost.id);
    expect(row).toMatchObject({
      body: "",
      authorName: null,
      authorId: null,
      refetchRequired: true,
      requestId: null,
    });
    await deliver({ ...ghost, body: `${secretBody} edited` }, "update");
    const dump = await everyRowAsText();
    expect(dump).not.toContain("payroll");
    expect(dump).not.toContain(secretName);
    await resolveOrphanComments(p.h.db, {
      now: new Date(Date.now() + 601_000),
    });
    expect(await inboundOf(ghost.id)).toBeUndefined();
  });

  test("an orphan is resolved with the body Linear holds after the ticket exists", async () => {
    let commentId = "";
    const made = await ticketlessWithRace(async (issueId) => {
      const early = await p.stub.staffComment({
        issueId,
        body: "@external first words [s=4]",
      });
      commentId = early.comment.id;
      await p.stub.editComment(commentId, "@external edited words [s=4]");
    });
    const row = await inboundOf(commentId);
    expect(row).toMatchObject({ body: "", refetchRequired: true });
    await p.drain(made.requestId);
    const bodies = bodiesOf(await p.thread(made.who as never, made.requestId));
    expect(bodies).toContain("edited words [s=4]");
    expect(bodies.join("\n")).not.toContain("first words");
    expect(await inboundOf(commentId)).toMatchObject({
      refetchRequired: false,
      authorId: STUB_STAFF_ID,
      authorName: "Ada Staff",
    });
  });

  test("an orphan removed before the ticket appeared shows the customer nothing", async () => {
    let commentId = "";
    const made = await ticketlessWithRace(async (issueId) => {
      const early = await p.stub.staffComment({
        issueId,
        body: "@external will be removed [s=4]",
      });
      commentId = early.comment.id;
      p.stub.configureWebhook(null);
      await p.stub.removeComment(commentId);
      p.stub.configureWebhook(target());
    });
    await p.drain(made.requestId);
    expect(bodiesOf(await p.thread(made.who as never, made.requestId))).toEqual(
      ["Where is my invoice?"],
    );
    expect(await inboundOf(commentId)).toMatchObject({
      disposition: "removed",
      body: "",
    });
  });

  test("two tickets cannot share a Linear issue", async () => {
    const a = await p.scenario();
    const b = await p.scenario();
    await expect(
      (async () => {
        await p.h.db
          .update(tickets)
          .set({ linearIssueId: a.issueId })
          .where(eq(tickets.requestId, b.requestId));
      })(),
    ).rejects.toThrow();
  });
});

describe("N1 edit order is tracked", () => {
  test("an update before its create makes the retried create resolve the current text", async () => {
    const s = await p.scenario();
    const made = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external old words [s=4]",
      deliver: false,
    });
    const original = { ...made.comment };
    const update = await p.stub.editComment(
      made.comment.id,
      "@external new words [s=4]",
    );
    expect(update?.body).toContain("unknown_comment");
    expect((await deliver(original)).status).toBe(200);
    await p.drain(s.requestId);
    const bodies = bodiesOf(await p.thread(s.who, s.requestId));
    expect(bodies).toContain("new words [s=4]");
    expect(bodies.join("\n")).not.toContain("old words");
    const stored = await p.storedMessages(s.requestId);
    expect(stored.map((m) => m.body).join("\n")).not.toContain("old words");
  });

  test("out of order edits keep the newest and a replayed old update changes nothing", async () => {
    const s = await p.scenario();
    const commentId = crypto.randomUUID();
    const at = (n: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, n));
    await persistInboundComment(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      issueId: s.issueId,
      parentCommentId: null,
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      body: "@external v1 [s=4]",
      sourceCreatedAt: at(1),
      sourceUpdatedAt: at(1),
    });
    const change = (body: string, n: number) =>
      applyCommentChange(p.h.db, {
        deliveryId: crypto.randomUUID(),
        commentId,
        action: "update",
        body,
        updatedAt: at(n),
      });
    expect(await change("@external v3 [s=4]", 3)).toEqual({
      status: "updated",
    });
    expect(await change("@external v2 [s=4]", 2)).toEqual({ status: "stale" });
    expect(await change("@external v3 [s=4]", 3)).toEqual({ status: "stale" });
    expect((await inboundOf(commentId))?.body).toBe("@external v3 [s=4]");
    await p.drain(s.requestId);
    const bodies = bodiesOf(await p.thread(s.who, s.requestId));
    expect(bodies).toContain("v3 [s=4]");
    expect(bodies.join("\n")).not.toContain("v2");
  });

  test("a remove before the create leaves nothing to process", async () => {
    const s = await p.scenario();
    const made = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external gone [s=4]",
      deliver: false,
    });
    const original = { ...made.comment };
    expect((await p.stub.removeComment(made.comment.id))?.body).toContain(
      "unknown_comment",
    );
    const retried = await deliver(original);
    expect(retried.body).toContain("superseded");
    expect(await inboundOf(original.id)).toBeUndefined();
    await p.drain(s.requestId);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
  });

  test("a recorded change newer than the stored body forces a fetch before scoring", async () => {
    const s = await p.scenario();
    const made = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external stored words [s=4]",
      deliver: false,
    });
    await persistInboundComment(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId: made.comment.id,
      issueId: s.issueId,
      parentCommentId: null,
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      body: "@external stored words [s=4]",
      sourceCreatedAt: new Date(Date.now() - 5000),
      sourceUpdatedAt: new Date(Date.now() - 5000),
    });
    made.comment.body = "@external current words [s=4]";
    const changedAt = new Date(Date.now() + 60_000);
    made.comment.updatedAt = changedAt.toISOString();
    await p.h.db.insert(commentChanges).values({
      commentId: made.comment.id,
      action: "update",
      updatedAt: changedAt,
    });
    await p.drain(s.requestId);
    const bodies = bodiesOf(await p.thread(s.who, s.requestId));
    expect(bodies).toContain("current words [s=4]");
    expect(bodies.join("\n")).not.toContain("stored words");
  });

  test("a confirm refetches a held comment that has a newer recorded change and cancels the hold", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    const heldRow = await inboundOf(held.id);
    held.body = "@external rewritten since [s=4]";
    await p.h.db.insert(commentChanges).values({
      commentId: held.id,
      action: "update",
      updatedAt: new Date(
        (heldRow?.sourceUpdatedAt?.getTime() ?? Date.now()) + 60_000,
      ),
    });
    await staff(s, "@confirm", { parentId: held.id });
    const [reply] = await p.repliesFor(s.requestId);
    expect(reply).toMatchObject({
      status: "cancelled",
      cancelReason: "edited",
    });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
  });
});

describe("C1 a confirm is released only against the body it was judged on", () => {
  test("an edited confirm comment is not released as a confirm", async () => {
    const s = await p.scenario();
    const commentId = crypto.randomUUID();
    const stored = await persistInboundComment(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      issueId: s.issueId,
      parentCommentId: crypto.randomUUID(),
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      body: "@confirm",
      sourceCreatedAt: new Date(),
      sourceUpdatedAt: new Date(Date.now() - 1000),
    });
    const inboundId = stored.status === "stored" ? stored.inbound.id : "";
    await applyCommentChange(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      action: "update",
      body: "@confirm but not really",
      updatedAt: new Date(),
    });
    expect(
      await confirmHeldReply(p.h.db, { inboundId, sourceBody: "@confirm" }),
    ).toBeNull();
    expect((await inboundOf(commentId))?.status).toBe("pending");
  });
});

describe("C2 a payload without createdAt never confirms or replies", () => {
  test("it is stored internal", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough [s=1.0]");
    const send = async (body: string, parentId: string | null) => {
      const comment: StubComment = {
        id: crypto.randomUUID(),
        issueId: s.issueId,
        body,
        userId: STUB_STAFF_ID,
        userName: "Ada",
        parentId,
      };
      const payload = commentWebhookPayload(comment);
      delete (payload.data as Record<string, unknown>).createdAt;
      expect(await post(payload)).toMatchObject({ status: "accepted" });
      return comment;
    };
    const marked = await send("@external hello [s=4]", null);
    const confirm = await send("@confirm", held.id);
    await p.drain(s.requestId);
    for (const comment of [marked, confirm]) {
      expect(await inboundOf(comment.id)).toMatchObject({
        authorId: null,
        disposition: "internal",
      });
    }
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
    expect((await p.repliesFor(s.requestId))[0]?.status).toBe("held");
  });
});

describe("C3 app, bot, and integration markers are never human", () => {
  const machine: [string, Omit<StaffCommentInput, "issueId" | "body">][] = [
    ["an OAuthApp actor", { payloadExtra: { actor: { type: "OAuthApp" } } }],
    [
      "an Integration actor",
      { payloadExtra: { actor: { type: "Integration" } } },
    ],
    ["an actor flagged app", { payloadExtra: { actor: { app: true } } }],
    [
      "a user flagged app",
      { payloadExtra: { data: { user: { id: STUB_STAFF_ID, app: true } } } },
    ],
    [
      "a user of type bot",
      { payloadExtra: { data: { user: { id: STUB_STAFF_ID, type: "bot" } } } },
    ],
  ];
  for (const [label, options] of machine) {
    test(`${label} stays internal`, async () => {
      const s = await p.scenario();
      const comment = await staff(s, "@external looks human [s=4]", options);
      expect(await inboundOf(comment.id)).toMatchObject({
        authorId: null,
        disposition: "internal",
      });
      expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
    });
  }

  test("a capitalised User actor is a human", async () => {
    const s = await p.scenario();
    await staff(s, "@external real person [s=4]", {
      payloadExtra: { actor: { type: "User" } },
    });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toContain(
      "real person [s=4]",
    );
  });
});

describe("C4 a cancelled hold is announced once", () => {
  test("the thread gets one notice and a later confirm gets no answer", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    await p.stub.editComment(held.id, "@external edited text [s=1.0]");
    await p.drain(s.requestId);
    const notices = () =>
      p.stub.comments.filter(
        (c) =>
          c.issueId === s.issueId && c.body.startsWith("Reply hold cancelled."),
      );
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.parentId).toBe(held.id);
    expect(notices()[0]?.body).toContain("@external");
    const [cancelled] = await p.h.db
      .select({ seq: events.seq })
      .from(events)
      .where(
        and(
          eq(events.requestId, s.requestId),
          eq(events.type, "reply.cancelled"),
        ),
      );
    const event = await getEventBySeq(p.h.db, cancelled?.seq as number);
    if (!event) throw new Error("event missing");
    await p.adapter.handle(event, { now: p.h.clock.now });
    expect(notices()).toHaveLength(1);
    const before = p.stub.comments.length;
    await staff(s, "@confirm", { parentId: held.id });
    expect(p.stub.comments.length).toBe(before + 1);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
  });
});

describe("C6 a second late attachment after a crash is still listed", () => {
  test("a comment already posted for the first attachment does not hide the second", async () => {
    const s = await p.scenario();
    const sent = await p.followUp(s.who, s.requestId, "files are coming");
    await p.drain(s.requestId);
    const add = (filename: string) =>
      recordAttachment(p.h.db, {
        messageId: sent.message.id,
        filename,
        contentType: "text/plain",
        sizeBytes: 5,
        storageKey: `k/${crypto.randomUUID()}`,
        sha256: "0".repeat(64),
      });
    await add("first.log");
    await p.adapter.syncFollowUps(s.requestId);
    await p.h.db
      .update(attachments)
      .set({ linearDeliveredAt: null })
      .where(eq(attachments.messageId, sent.message.id));
    await add("second.log");
    await p.adapter.syncFollowUps(s.requestId);
    const lists = p.stub.comments.filter((c) =>
      c.body.includes("Attachments added later"),
    );
    expect(lists).toHaveLength(2);
    expect(lists[1]?.body).toContain("second.log");
  });
});
