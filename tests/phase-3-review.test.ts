import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as channels from "@pw-support/channels";
import { createLinearAdapter, requestMarker } from "@pw-support/channels";
import {
  type CommentAction,
  commentWebhookPayload,
  deliverCommentWebhook,
  STUB_STAFF_ID,
  STUB_VIEWER_ID,
  type StaffCommentInput,
  type StubComment,
  signLinearWebhook,
} from "@pw-support/channels/testing";
import {
  REPLY_HOLD_TTL_SECONDS,
  TICKET_REDELIVERY_BASE_SECONDS,
} from "@pw-support/contracts";
import {
  applyCommentChange,
  attachments,
  claimFollowUpRedeliveries,
  claimStaleInboundEvents,
  inboundComments,
  listHeldReplies,
  markMessageIntakeComplete,
  messageDeliveries,
  messages as messagesTable,
  persistInboundComment,
  persistInboundMessage,
  recordAttachment,
  replies,
  resolveExternalReply,
  resolveOrphanComments,
  upsertCustomer,
  webhookDeliveries,
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

function useFreshHarness() {
  let saved: Phase3Harness;
  beforeAll(async () => {
    saved = p;
    p = await createPhase3Harness();
  });
  afterAll(async () => {
    await p.close();
    p = saved;
  });
}

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
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
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

async function inboundOf(requestId: string, commentId: string) {
  const rows = await p.inboundFor(requestId);
  return rows.find((row) => row.commentId === commentId);
}

async function handleDue(s: Scenario) {
  const due = await p.adapter.redeliver();
  for (const event of due.filter((e) => e.requestId === s.requestId)) {
    await p.adapter.handle(event, { now: p.h.clock.now });
  }
}

async function newTicketless() {
  const who = await p.h.tenant({ teamId: p.stub.teams[0]?.id });
  return { who, team: p.stub.teams[0]?.id as string };
}

async function addFollowUpRow(
  who: Awaited<ReturnType<typeof newTicketless>>["who"],
  requestId: string,
  body: string,
) {
  const project = await p.h.db.query.projects.findFirst({
    where: (t, { eq: same }) => same(t.id, who.projectId),
  });
  const customer = await upsertCustomer(
    p.h.db,
    who.projectId,
    who.headers["X-Support-User"] as string,
  );
  const result = await persistInboundMessage(p.h.db, {
    scope: { project: project as never, customer },
    requestId,
    body,
  });
  const id = result?.message.id as string;
  await p.h.db
    .update(messagesTable)
    .set({ createdAt: new Date(p.h.clock.now().getTime() + 5000) })
    .where(eq(messagesTable.id, id));
  return id;
}

describe("S1 an edit or a delete cancels a hold", () => {
  test("hold then edit then confirm sends nothing", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    const edited = await p.stub.editComment(
      held.id,
      "@external polished text [s=4]",
    );
    expect(edited?.status).toBe(200);
    expect(edited?.body).toContain("cancelled");
    const [reply] = await p.repliesFor(s.requestId);
    expect(reply).toMatchObject({
      status: "cancelled",
      cancelReason: "edited",
    });
    expect(await p.eventTypes(s.requestId)).toContain("reply.cancelled");
    await staff(s, "@confirm", { parentId: held.id });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toEqual([
      "Where is my invoice?",
    ]);
    const confirm = (await p.inboundFor(s.requestId)).find(
      (row) => row.body === "@confirm",
    );
    expect(confirm?.disposition).toBe("confirm_ignored:no_hold");
    expect(await listHeldReplies(p.h.db, s.requestId)).toHaveLength(0);
  });

  test("hold then remove then confirm sends nothing", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    const removed = await p.stub.removeComment(held.id);
    expect(removed?.status).toBe(200);
    const [reply] = await p.repliesFor(s.requestId);
    expect(reply).toMatchObject({
      status: "cancelled",
      cancelReason: "removed",
    });
    await staff(s, "@confirm", { parentId: held.id });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
  });

  test("an edit of a sent reply changes nothing the customer saw", async () => {
    const s = await p.scenario();
    const sent = await staff(s, "@external Original wording. [s=4]");
    await p.stub.editComment(sent.id, "@external Changed wording. [s=4]");
    await p.stub.removeComment(sent.id);
    await p.drain(s.requestId);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toEqual([
      "Where is my invoice?",
      "Original wording. [s=4]",
    ]);
    const [reply] = await p.repliesFor(s.requestId);
    expect(reply?.status).toBe("sent");
    expect(await p.eventTypes(s.requestId)).not.toContain("reply.cancelled");
  });

  test("an edit webhook for an unknown comment is ignored", async () => {
    const s = await p.scenario();
    const ghost: StubComment = {
      id: crypto.randomUUID(),
      issueId: s.issueId,
      body: "@external ghost",
      userId: STUB_STAFF_ID,
      userName: "Ada Staff",
      parentId: null,
    };
    const update = await deliver(ghost, "update");
    const remove = await deliver(ghost, "remove");
    expect(update.body).toContain("unknown_comment");
    expect(remove.body).toContain("unknown_comment");
    expect(await p.inboundFor(s.requestId)).toHaveLength(0);
  });

  test("an update that keeps the body, such as a reaction, leaves the hold", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    const same = await p.stub.editComment(held.id, held.body);
    expect(same?.body).toContain("unchanged");
    expect((await p.repliesFor(s.requestId))[0]?.status).toBe("held");
    await staff(s, "@confirm", { parentId: held.id });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(2);
  });

  test("an edit or a delete before processing updates or drops the comment", async () => {
    const s = await p.scenario();
    const first = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external first draft [s=4]",
    });
    await p.stub.editComment(first.comment.id, "@external second draft [s=4]");
    const second = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external never sent [s=4]",
    });
    await p.stub.removeComment(second.comment.id);
    await p.drain(s.requestId);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toEqual([
      "Where is my invoice?",
      "second draft [s=4]",
    ]);
    expect((await inboundOf(s.requestId, second.comment.id))?.disposition).toBe(
      "removed",
    );
  });

  test("a reply judged on an older body is never released", async () => {
    const s = await p.scenario();
    const commentId = crypto.randomUUID();
    const stored = await persistInboundComment(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      issueId: s.issueId,
      parentCommentId: null,
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      body: "@external old",
      sourceCreatedAt: new Date(),
    });
    const inboundId = stored.status === "stored" ? stored.inbound.id : "";
    await applyCommentChange(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      action: "update",
      body: "@external new",
    });
    const stale = await resolveExternalReply(p.h.db, {
      inboundId,
      sourceBody: "@external old",
      text: "old",
      score: 4,
      band: "send",
      raw: {},
    });
    expect(stale).toBeNull();
    expect(await p.storedMessages(s.requestId)).toHaveLength(1);
  });
});

describe("S2 a comment without a Linear user is internal", () => {
  const shapes: [string, Omit<StaffCommentInput, "issueId" | "body">][] = [
    ["a null user id", { userId: null }],
    [
      "a botActor",
      { payloadExtra: { data: { botActor: { id: "b1", name: "Bot" } } } },
    ],
    ["an externalUserId", { payloadExtra: { data: { externalUserId: "e1" } } }],
    [
      "an externalUser",
      { payloadExtra: { data: { externalUser: { id: "e1", name: "Eve" } } } },
    ],
    [
      "an integration actor",
      { payloadExtra: { actor: { type: "integration" } } },
    ],
  ];

  for (const [label, options] of shapes) {
    test(`${label} is stored internal and neither replies nor confirms`, async () => {
      const s = await p.scenario();
      const held = await staff(s, "@external rough [s=1.0]");
      const marked = await staff(s, "@external hello customer [s=4]", options);
      const confirm = await staff(s, "@confirm", {
        ...options,
        parentId: held.id,
      });
      expect(bodiesOf(await p.thread(s.who, s.requestId))).toEqual([
        "Where is my invoice?",
      ]);
      expect((await p.repliesFor(s.requestId)).map((r) => r.status)).toEqual([
        "held",
      ]);
      for (const comment of [marked, confirm]) {
        const row = await inboundOf(s.requestId, comment.id);
        expect(row).toMatchObject({ authorId: null, disposition: "internal" });
      }
      const internal = (await p.storedMessages(s.requestId)).filter(
        (m) => m.audience === "internal",
      );
      expect(internal.map((m) => m.body)).toEqual([
        "@external hello customer [s=4]",
        "@confirm",
      ]);
    });
  }

  test("the author name comes only from the comment user", async () => {
    const s = await p.scenario();
    const comment = await staff(s, "@external Hi there. [s=4]", {
      userName: "Actor Name",
      payloadExtra: { data: { user: { id: STUB_STAFF_ID } } },
    });
    expect((await inboundOf(s.requestId, comment.id))?.authorName).toBeNull();
    expect(
      (await p.thread(s.who, s.requestId)).messages.at(-1)?.authorName,
    ).toBeNull();
  });
});

describe("S3 a confirm answers only the hold it was written for", () => {
  useFreshHarness();

  test("a late processed confirm does not release a newer hold", async () => {
    const s = await p.scenario();
    const t0 = Date.now();
    const first = await staff(s, "@external first rough [s=1.0]", {
      createdAt: new Date(t0),
    });
    const newer = await staff(s, "@external newer rough [s=1.0]", {
      parentId: first.id,
      createdAt: new Date(t0 + 40),
      deliver: false,
    });
    const confirm = await staff(s, "@confirm", {
      parentId: first.id,
      createdAt: new Date(t0 + 20),
      deliver: false,
    });
    await deliver(newer);
    await deliver(confirm);
    await p.drain(s.requestId);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toEqual([
      "Where is my invoice?",
      "first rough [s=1.0]",
    ]);
    const states = await p.repliesFor(s.requestId);
    expect(states.map((r) => r.status).sort()).toEqual(["held", "sent"]);
    expect(states.find((r) => r.status === "held")?.body).toBe(
      "newer rough [s=1.0]",
    );
  });

  test("a confirm older than every hold in its thread releases nothing", async () => {
    const s = await p.scenario();
    const t0 = Date.now();
    const root = await staff(s, "@external rough [s=1.0]", {
      createdAt: new Date(t0 + 50),
      deliver: false,
    });
    const confirm = await staff(s, "@confirm", {
      parentId: root.id,
      createdAt: new Date(t0 + 10),
      deliver: false,
    });
    await deliver(root);
    await p.drain(s.requestId);
    await deliver(confirm);
    await p.drain(s.requestId);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
    expect((await inboundOf(s.requestId, confirm.id))?.disposition).toBe(
      "confirm_ignored:no_hold",
    );
  });

  test("a confirm that arrives before its hold is retried and then releases it", async () => {
    const s = await p.scenario();
    const t0 = Date.now();
    const root = await staff(s, "@external rough [s=1.0]", {
      createdAt: new Date(t0),
      deliver: false,
    });
    const confirm = await staff(s, "@confirm", {
      parentId: root.id,
      createdAt: new Date(t0 + 20),
      deliver: false,
    });
    await deliver(confirm);
    await p.drain(s.requestId);
    expect((await inboundOf(s.requestId, confirm.id))?.status).toBe("pending");
    await deliver(root);
    await p.drain(s.requestId);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
    expect((await inboundOf(s.requestId, confirm.id))?.status).toBe("pending");
    p.h.clock.advance(TICKET_REDELIVERY_BASE_SECONDS + 1);
    await handleDue(s);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toEqual([
      "Where is my invoice?",
      "rough [s=1.0]",
    ]);
    expect((await inboundOf(s.requestId, confirm.id))?.disposition).toBe(
      "confirm",
    );
  });

  test("a confirm waits until the hold warning is posted", async () => {
    const s = await p.scenario();
    p.stub.failNext(1);
    const t0 = Date.now();
    const held = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external rough [s=1.0]",
      createdAt: new Date(t0),
    });
    await p.drain(s.requestId).catch(() => {});
    const [unwarned] = await p.repliesFor(s.requestId);
    expect(unwarned).toMatchObject({ status: "held", warningCommentId: null });
    await staff(s, "@confirm", {
      parentId: held.comment.id,
      createdAt: new Date(t0 + 20),
    });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
    p.h.clock.advance(TICKET_REDELIVERY_BASE_SECONDS + 1);
    await handleDue(s);
    await handleDue(s);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(2);
  });
});

describe("S4 released staff text is plain text", () => {
  test("links, images, and linear urls do not reach the customer and angle brackets stay text", async () => {
    const s = await p.scenario();
    await staff(
      s,
      "@external Hi [Ada](https://evil.example/x) ![img](https://uploads.linear.app/a.png) see https://linear.app/acme/issue/A-1 and https://docs.example.com/guide <b>now</b> [s=4]",
    );
    expect((await p.thread(s.who, s.requestId)).messages.at(-1)?.body).toBe(
      "Hi Ada  see  and https://docs.example.com/guide <b>now</b> [s=4]",
    );
    const scored = p.wording as unknown as { calls: string[] };
    expect(scored.calls.at(-1)).toBe(
      "Hi Ada  see  and https://docs.example.com/guide <b>now</b> [s=4]",
    );
  });

  test("a reply with only an image is internal", async () => {
    const s = await p.scenario();
    await staff(s, "@external ![shot](https://x.example/i.png)");
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
  });
});

describe("S5 the production barrel hides signing", () => {
  test("only the verifier is exported", () => {
    expect("signLinearWebhook" in channels).toBe(false);
    expect(typeof channels.signatureMatches).toBe("function");
    expect(typeof signLinearWebhook).toBe("function");
  });
});

describe("S6 a comment before its ticket row is kept for a while", () => {
  test("it attaches when the ticket row appears and is then processed", async () => {
    const { who } = await newTicketless();
    const submitted = await p.h.submit(who, "Where is my invoice?");
    p.h.clock.advance(61);
    await handleWake(p.h.deps, submitted.jobId);
    let early: Awaited<ReturnType<typeof p.stub.staffComment>> | undefined;
    const racing = {
      ...p.linear,
      async createIssue(input: Parameters<typeof p.linear.createIssue>[0]) {
        const issue = await p.linear.createIssue(input);
        early = await p.stub.staffComment({
          issueId: issue.id,
          body: "@external early reply [s=4]",
        });
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
    expect(early?.delivery?.body).toContain("awaiting_ticket");
    const row = await inboundOf(submitted.requestId, early?.comment.id ?? "");
    expect(row?.status).toBe("pending");
    expect(await p.eventTypes(submitted.requestId)).toContain(
      "comment.received",
    );
    await p.drain(submitted.requestId);
    expect(
      bodiesOf(await p.thread(who as never, submitted.requestId)),
    ).toContain("early reply [s=4]");
  });

  test("the redelivery sweep attaches a comment whose ticket row came later", async () => {
    const s = await p.scenario();
    const late = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external late attach [s=4]",
      deliver: false,
    });
    await p.h.db.insert(inboundComments).values({
      commentId: late.comment.id,
      issueId: s.issueId,
      body: "",
      refetchRequired: true,
      requestId: null,
    });
    expect(await resolveOrphanComments(p.h.db)).toEqual({
      attached: 1,
      ignored: 0,
    });
    await p.drain(s.requestId);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toContain(
      "late attach [s=4]",
    );
  });

  test("it is deleted once the window passes, never guessing a request", async () => {
    const ghost: StubComment = {
      id: crypto.randomUUID(),
      issueId: `issue-ghost-${crypto.randomUUID()}`,
      body: "@external for a ticket that never comes",
      userId: STUB_STAFF_ID,
      userName: "Ada",
      parentId: null,
    };
    expect((await deliver(ghost)).body).toContain("awaiting_ticket");
    const find = () =>
      p.h.db.query.inboundComments.findFirst({
        where: (t, { eq: same }) => same(t.commentId, ghost.id),
      });
    expect((await find())?.status).toBe("pending");
    const soon = new Date(Date.now() + 60_000);
    expect(await resolveOrphanComments(p.h.db, { now: soon })).toMatchObject({
      ignored: 0,
    });
    const late = new Date(Date.now() + 601_000);
    const resolution = await resolveOrphanComments(p.h.db, { now: late });
    expect(resolution.ignored).toBeGreaterThanOrEqual(1);
    expect(await find()).toBeUndefined();
  });
});

describe("C1 stale inbound redelivery backs off and never starves", () => {
  test("25 failing comments do not block a newer comment and enqueues stay bounded", async () => {
    const s = await p.scenario();
    const make = async () => {
      const stored = await persistInboundComment(p.h.db, {
        deliveryId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        issueId: s.issueId,
        parentCommentId: null,
        authorId: STUB_STAFF_ID,
        authorName: null,
        body: "never processed",
        sourceCreatedAt: new Date(),
      });
      if (stored.status !== "stored") throw new Error("expected stored");
      return stored.inbound.id;
    };
    const old = await Promise.all(Array.from({ length: 25 }, make));
    const base = Date.now();
    const at = (seconds: number) => new Date(base + seconds * 1000);
    const claim = async (seconds: number) =>
      (
        await claimStaleInboundEvents(p.h.db, {
          now: at(seconds),
          requestId: s.requestId,
        })
      ).map((event) => event.payload.inboundId as string);
    expect(await claim(1)).toEqual([]);
    expect(await claim(31)).toHaveLength(20);
    expect(await claim(31)).toHaveLength(5);
    const fresh = await make();
    expect(await claim(32)).toEqual([fresh]);
    const counts = new Map<string, number>();
    for (let seconds = 33; seconds <= 3600; seconds += 10) {
      for (const id of await claim(seconds)) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    for (const id of [...old, fresh]) {
      const total = (counts.get(id) ?? 0) + (id === fresh ? 1 : 2);
      expect(total).toBeGreaterThanOrEqual(5);
      expect(total).toBeLessThanOrEqual(10);
    }
  });
});

describe("C2 a follow-up is delivered via the ticket only when it is in the description", () => {
  useFreshHarness();

  test("a message whose intake is unfinished flows as a comment later", async () => {
    const { who } = await newTicketless();
    const submitted = await p.h.submit(who, "Original problem text");
    const lateId = await addFollowUpRow(
      who,
      submitted.requestId,
      "second message still uploading",
    );
    p.h.clock.advance(61);
    await handleWake(p.h.deps, submitted.jobId);
    const outcome = await p.adapter.createTicketForRequest(submitted.requestId);
    expect(outcome.status).toBe("created");
    const issueId =
      outcome.status === "created" ? outcome.ticket.linearIssueId : "";
    const description = p.stub.issues.find(
      (i) => i.id === issueId,
    )?.description;
    expect(description).toContain("Original problem text");
    expect(description).not.toContain("still uploading");
    const [late] = await p.h.db
      .select()
      .from(messageDeliveries)
      .where(eq(messageDeliveries.messageId, lateId));
    expect(late).toBeUndefined();
    await markMessageIntakeComplete(p.h.db, lateId, p.h.clock.now());
    await p.drain(submitted.requestId);
    const comments = p.stub.comments.filter((c) => c.issueId === issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("second message still uploading");
  });

  test("a message that does not fit the quote cap flows as a comment", async () => {
    const { who } = await newTicketless();
    const submitted = await p.h.submit(who, "short original");
    const big = await p.followUp(who, submitted.requestId, "y".repeat(5000));
    p.h.clock.advance(61);
    await handleWake(p.h.deps, submitted.jobId);
    const outcome = await p.adapter.createTicketForRequest(submitted.requestId);
    const issueId =
      outcome.status === "created" ? outcome.ticket.linearIssueId : "";
    const description = p.stub.issues.find(
      (i) => i.id === issueId,
    )?.description;
    expect(description).toContain("short original");
    expect(description).not.toContain("yyyy");
    expect(description).toContain("[further messages follow as comments]");
    await p.drain(submitted.requestId);
    const comments = p.stub.comments.filter((c) => c.issueId === issueId);
    expect(comments).toHaveLength(2);
    expect(
      comments[0]?.body.endsWith(
        `Support message ID: ${big.message.id} part 1 of 2`,
      ),
    ).toBe(true);
    expect(
      comments[1]?.body.endsWith(
        `Support message ID: ${big.message.id} part 2 of 2`,
      ),
    ).toBe(true);
    expect(comments.map((c) => c.body).join("")).toContain("y".repeat(1000));
  });

  test("an issue adopted by marker marks nothing and the messages flow as comments", async () => {
    const { who, team } = await newTicketless();
    const submitted = await p.h.submit(who, "Adopt me please");
    p.h.clock.advance(61);
    await handleWake(p.h.deps, submitted.jobId);
    await p.linear.createIssue({
      teamId: team,
      title: "Pre-existing",
      description: `earlier attempt\n\n${requestMarker(submitted.requestId)}`,
      priority: 0,
      labelIds: [],
    });
    const outcome = await p.adapter.createTicketForRequest(submitted.requestId);
    expect(outcome.status).toBe("created");
    const issueId =
      outcome.status === "created" ? outcome.ticket.linearIssueId : "";
    const before = await p.h.db
      .select()
      .from(messageDeliveries)
      .where(eq(messageDeliveries.requestId, submitted.requestId));
    expect(before.filter((row) => row.deliveredAt !== null)).toHaveLength(0);
    await p.drain(submitted.requestId);
    const comments = p.stub.comments.filter((c) => c.issueId === issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Adopt me please");
  });

  test("an attachment that finishes after delivery is posted as a filename list once", async () => {
    const s = await p.scenario();
    const sent = await p.followUp(s.who, s.requestId, "see attachment soon");
    await p.drain(s.requestId);
    const count = () =>
      p.stub.comments.filter(
        (c) => c.issueId === s.issueId && c.userId === STUB_VIEWER_ID,
      );
    expect(count()).toHaveLength(1);
    await recordAttachment(p.h.db, {
      messageId: sent.message.id,
      filename: "late.log",
      contentType: "text/plain",
      sizeBytes: 5,
      storageKey: `k/${crypto.randomUUID()}`,
      sha256: "0".repeat(64),
    });
    const due = await claimFollowUpRedeliveries(p.h.db, {
      now: p.h.clock.now(),
      requestId: s.requestId,
    });
    expect(due).toHaveLength(1);
    for (const event of due)
      await p.adapter.handle(event, { now: p.h.clock.now });
    expect(count()).toHaveLength(2);
    expect(count()[1]?.body).toContain(
      "Attachments added later:\n- `late.log`",
    );
    expect(await p.adapter.syncFollowUps(s.requestId)).toBe(0);
    expect(count()).toHaveLength(2);
    const [row] = await p.h.db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, sent.message.id));
    expect(row?.linearDeliveredAt).not.toBeNull();
  });
});

describe("C3 only system comments and recorded ids are our own", () => {
  test("a human comment that quotes the prefix mid body is a real reply", async () => {
    const s = await p.scenario();
    await staff(
      s,
      "@external Thanks.\n\nCustomer follow-up via widget was received. [s=4]",
    );
    expect(
      (await p.thread(s.who, s.requestId)).messages.at(-1)?.body,
    ).toContain("Customer follow-up via widget was received.");
  });

  test("a system comment whose id was never recorded is still recognised by prefix", async () => {
    const s = await p.scenario();
    const created = await p.linear.createComment(
      s.issueId,
      "Customer follow-up via widget\n\n> stray unrecorded comment",
    );
    await p.waitFor(() =>
      p.stub.deliveries.some((d) => d.commentId === created.id),
    );
    await p.drain(s.requestId);
    expect((await inboundOf(s.requestId, created.id))?.disposition).toBe(
      "own_comment",
    );
  });
});

describe("C5 redelivery scans have partial indexes", () => {
  test("the partial and expression indexes exist", async () => {
    const rows = await p.h.db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'support' AND tablename = 'events'`,
    );
    const names = rows.map((row) => row.indexname);
    for (const name of [
      "events_message_created_seq_idx",
      "events_message_created_ref_idx",
      "events_comment_received_seq_idx",
      "events_comment_received_ref_idx",
      "events_triage_accepted_seq_idx",
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe("C6 clock and ordering", () => {
  test("replies keep the order of their Linear timestamps", async () => {
    const s = await p.scenario();
    const t0 = Date.now();
    const one = await staff(s, "@external one [s=4]", {
      createdAt: new Date(t0),
      deliver: false,
    });
    const two = await staff(s, "@external two [s=4]", {
      createdAt: new Date(t0 + 5),
      deliver: false,
    });
    await deliver(two);
    await p.drain(s.requestId);
    await deliver(one);
    await p.drain(s.requestId);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toEqual([
      "Where is my invoice?",
      "one [s=4]",
      "two [s=4]",
    ]);
  });

  test("a reply written before a read but stored after it is still unread", async () => {
    const s = await p.scenario();
    await p.call(s.who, `/requests/${s.requestId}/read`, { method: "POST" });
    expect(await p.unread(s.who, s.requestId)).toBe(0);
    await staff(s, "@external written earlier [s=4]", {
      createdAt: new Date(Date.now() - 60_000),
    });
    expect(await p.unread(s.who, s.requestId)).toBe(1);
  });
});

describe("C7 holds expire lazily and by sweep", () => {
  useFreshHarness();

  test("an expired hold is not listed, not re-warned, and is marked expired", async () => {
    const s = await p.scenario();
    p.stub.failNext(1);
    await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external rough [s=0.5]",
    });
    await p.drain(s.requestId).catch(() => {});
    expect((await p.repliesFor(s.requestId))[0]?.warningCommentId).toBeNull();
    p.h.clock.advance(TICKET_REDELIVERY_BASE_SECONDS + 1);
    const before = await claimStaleInboundEvents(p.h.db, {
      now: p.h.clock.now(),
      requestId: s.requestId,
    });
    expect(before).toHaveLength(1);
    p.h.clock.advance(REPLY_HOLD_TTL_SECONDS);
    expect(await listHeldReplies(p.h.db, s.requestId)).toHaveLength(1);
    expect(
      await listHeldReplies(p.h.db, s.requestId, p.h.clock.now()),
    ).toHaveLength(0);
    p.h.clock.advance(10_000);
    const after = await claimStaleInboundEvents(p.h.db, {
      now: p.h.clock.now(),
      requestId: s.requestId,
    });
    expect(after).toEqual([]);
    await p.adapter.redeliver();
    expect((await p.repliesFor(s.requestId))[0]?.status).toBe("expired");
    expect(await p.eventTypes(s.requestId)).toContain("reply.expired");
  });
});

describe("C8 a finished follow-up intake triggers delivery at once", () => {
  useFreshHarness();

  test("the intake completion event posts the comment without waiting for redelivery", async () => {
    const s = await p.scenario();
    const messageId = await addFollowUpRow(
      { projectId: s.who.projectId, headers: s.who.headers } as never,
      s.requestId,
      "slow follow-up",
    );
    await p.drain(s.requestId);
    const comments = () =>
      p.stub.comments.filter(
        (c) => c.issueId === s.issueId && c.userId === STUB_VIEWER_ID,
      );
    expect(comments()).toHaveLength(0);
    await markMessageIntakeComplete(p.h.db, messageId, p.h.clock.now());
    expect(await p.eventTypes(s.requestId)).toContain(
      "message.intake_completed",
    );
    await p.drain(s.requestId);
    expect(comments()).toHaveLength(1);
    expect(comments()[0]?.body).toContain("slow follow-up");
  });
});

describe("C9 one warning per hold under concurrency", () => {
  test("two concurrent deliveries post a single warning", async () => {
    const s = await p.scenario();
    p.stub.failNext(1);
    const held = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external rough [s=1.0]",
    });
    await p.drain(s.requestId).catch(() => {});
    const inbound = await inboundOf(s.requestId, held.comment.id);
    expect((await p.repliesFor(s.requestId))[0]?.warningCommentId).toBeNull();
    await Promise.all([
      p.adapter.processInboundComment(inbound?.id as string),
      p.adapter.processInboundComment(inbound?.id as string),
    ]);
    const warnings = p.stub.comments.filter(
      (c) => c.issueId === s.issueId && c.parentId === held.comment.id,
    );
    expect(warnings).toHaveLength(1);
    expect((await p.repliesFor(s.requestId))[0]?.warningCommentId).toBe(
      warnings[0]?.id as string,
    );
  });

  test("an unrecorded warning is found by its reply marker instead of being posted again", async () => {
    const s = await p.scenario();
    p.stub.failNext(1);
    const held = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external rough [s=1.0]",
    });
    await p.drain(s.requestId).catch(() => {});
    const [reply] = await p.repliesFor(s.requestId);
    const first = await p.linear.createComment(
      s.issueId,
      `Reply held, not sent to the customer. earlier attempt\n\nSupport reply ID: ${reply?.id}`,
      held.comment.id,
    );
    const inbound = await inboundOf(s.requestId, held.comment.id);
    await p.adapter.processInboundComment(inbound?.id as string);
    expect(
      p.stub.comments.filter((c) => c.parentId === held.comment.id),
    ).toHaveLength(1);
    expect((await p.repliesFor(s.requestId))[0]?.warningCommentId).toBe(
      first.id,
    );
  });
});

describe("C10 purge and impossible states", () => {
  test("old webhook delivery rows are purged by the periodic sweep", async () => {
    const old = `old-${crypto.randomUUID()}`;
    const recent = `recent-${crypto.randomUUID()}`;
    await p.h.db.insert(webhookDeliveries).values([
      {
        deliveryId: old,
        provider: "linear",
        receivedAt: new Date(Date.now() - 8 * 86_400_000),
      },
      { deliveryId: recent, provider: "linear" },
    ]);
    p.h.clock.advance(601);
    await p.adapter.redeliver();
    const left = await p.h.db
      .select()
      .from(webhookDeliveries)
      .where(sql`${webhookDeliveries.deliveryId} IN (${old}, ${recent})`);
    expect(left.map((row) => row.deliveryId)).toEqual([recent]);
  });

  test("the database rejects a held reply without expiry and a sent reply without a message", async () => {
    const s = await p.scenario();
    const make = async () => {
      const stored = await persistInboundComment(p.h.db, {
        deliveryId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        issueId: s.issueId,
        parentCommentId: null,
        authorId: STUB_STAFF_ID,
        authorName: null,
        body: "x",
        sourceCreatedAt: new Date(),
      });
      return stored.status === "stored" ? stored.inbound.id : "";
    };
    const base = {
      requestId: s.requestId,
      threadRootId: "root",
      body: "b",
      wordingScore: 1,
    };
    await expect(
      Promise.resolve(
        p.h.db.insert(replies).values({
          ...base,
          inboundCommentId: await make(),
          status: "held",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        p.h.db.insert(replies).values({
          ...base,
          inboundCommentId: await make(),
          status: "sent",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        p.h.db.insert(replies).values({
          ...base,
          inboundCommentId: await make(),
          status: "cancelled",
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("webhook payload shapes", () => {
  test("a create payload without createdAt falls back to the receipt time", async () => {
    const s = await p.scenario();
    const comment: StubComment = {
      id: crypto.randomUUID(),
      issueId: s.issueId,
      body: "plain internal note",
      userId: STUB_STAFF_ID,
      userName: "Ada",
      parentId: null,
    };
    const payload = commentWebhookPayload(comment);
    const data = payload.data as Record<string, unknown>;
    data.createdAt = "not a date";
    const result = await post(payload);
    expect(result.body).toMatchObject({ status: "accepted" });
    const row = await inboundOf(s.requestId, comment.id);
    expect(row?.sourceCreatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const removal = await post({
      action: "remove",
      type: "Comment",
      webhookTimestamp: Date.now(),
      data: { nope: true },
    });
    expect(removal.body).toMatchObject({ reason: "not_an_issue_comment" });
    const other = await post({
      action: "restore",
      type: "Comment",
      webhookTimestamp: Date.now(),
      data: comment,
    });
    expect(other.body).toMatchObject({ reason: "event_not_handled" });
    expect(
      await p.h.db
        .select()
        .from(inboundComments)
        .where(
          and(
            eq(inboundComments.requestId, s.requestId),
            eq(inboundComments.commentId, comment.id),
          ),
        ),
    ).toHaveLength(1);
  });
});
