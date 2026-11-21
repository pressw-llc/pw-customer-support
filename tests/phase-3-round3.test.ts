import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  commentWebhookPayload,
  STUB_STAFF_ID,
  type StubComment,
  signLinearWebhook,
} from "@pw-support/channels/testing";
import {
  applyCommentChange,
  applyFetchedComment,
  commentChanges,
  commentNeedsRefresh,
  inboundComments,
  persistInboundComment,
} from "@pw-support/db";
import { and, eq } from "drizzle-orm";
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

async function post(payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const response = await fetch(p.webhookUrl, {
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
  options: { parentId?: string } = {},
) {
  const { comment, delivery } = await p.stub.staffComment({
    issueId: s.issueId,
    body,
    ...options,
  });
  expect(delivery?.status).toBe(200);
  await p.drain(s.requestId);
  return comment;
}

const bodiesOf = (t: Awaited<ReturnType<Phase3Harness["thread"]>>) =>
  t.messages.map((m) => m.body);

const inboundOf = async (commentId: string) => {
  const [row] = await p.h.db
    .select()
    .from(inboundComments)
    .where(eq(inboundComments.commentId, commentId));
  return row;
};

const changeOf = async (commentId: string) => {
  const [row] = await p.h.db
    .select()
    .from(commentChanges)
    .where(eq(commentChanges.commentId, commentId));
  return row;
};

const at = (n: number) => new Date(Date.UTC(2031, 0, 1, 0, 0, n));

function untimedUpdate(comment: StubComment, body: string) {
  const payload = commentWebhookPayload(
    { ...comment, body },
    Date.now(),
    "update",
  );
  delete (payload.data as Record<string, unknown>).updatedAt;
  return payload;
}

describe("H1 an update during a pending fetch is recorded and keeps the refetch", () => {
  test("H1 an update while refetch_required is true records the change", async () => {
    const commentId = `orphan-${crypto.randomUUID()}`;
    const stored = await persistInboundComment(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      issueId: `no-ticket-${crypto.randomUUID()}`,
      parentCommentId: null,
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      body: "@external ignored",
      sourceCreatedAt: at(1),
    });
    expect(stored.status).toBe("awaiting_ticket");
    expect((await inboundOf(commentId))?.refetchRequired).toBe(true);
    const result = await applyCommentChange(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      action: "update",
      body: "@external during the fetch",
      updatedAt: at(5),
    });
    expect(result.status).toBe("refetch_required");
    expect((await changeOf(commentId))?.updatedAt.getTime()).toBe(
      at(5).getTime(),
    );
    expect((await inboundOf(commentId))?.body).toBe("");
  });

  test("H1 applyFetchedComment keeps refetch_required while a newer change row remains", async () => {
    const s = await p.scenario();
    const commentId = `pending-${crypto.randomUUID()}`;
    await persistInboundComment(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      issueId: s.issueId,
      parentCommentId: null,
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      body: "@external v0 [s=4]",
      sourceCreatedAt: at(1),
      sourceUpdatedAt: at(1),
    });
    const row = await inboundOf(commentId);
    await p.h.db
      .update(inboundComments)
      .set({ refetchRequired: true })
      .where(eq(inboundComments.id, (row as NonNullable<typeof row>).id));
    await applyCommentChange(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      action: "update",
      body: "@external v2 [s=4]",
      updatedAt: at(9),
    });
    const fetched = (updatedAt: Date, body: string) => ({
      issueId: s.issueId,
      body,
      parentCommentId: null,
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      createdAt: at(1),
      updatedAt,
    });
    const id = (row as NonNullable<typeof row>).id;

    await applyFetchedComment(p.h.db, id, fetched(at(5), "@external v1 [s=4]"));
    expect(await inboundOf(commentId)).toMatchObject({
      body: "@external v1 [s=4]",
      refetchRequired: true,
    });
    expect(await changeOf(commentId)).toBeDefined();

    await applyFetchedComment(p.h.db, id, fetched(at(9), "@external v2 [s=4]"));
    expect(await inboundOf(commentId)).toMatchObject({
      body: "@external v2 [s=4]",
      refetchRequired: false,
    });
    expect(await changeOf(commentId)).toBeUndefined();
  });

  test("H1 the adapter leaves a comment pending while a newer change remains", async () => {
    const s = await p.scenario();
    const made = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external first [s=4]",
      deliver: false,
    });
    const commentId = made.comment.id;
    await persistInboundComment(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      issueId: s.issueId,
      parentCommentId: null,
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      body: "@external first [s=4]",
      sourceCreatedAt: at(1),
      sourceUpdatedAt: at(1),
    });
    made.comment.body = "@external second [s=4]";
    made.comment.updatedAt = at(5).toISOString();
    await p.h.db.insert(commentChanges).values({
      commentId,
      action: "update",
      updatedAt: at(9),
    });
    await p.drain(s.requestId);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toEqual([
      "Where is my invoice?",
    ]);
    expect((await inboundOf(commentId))?.status).toBe("pending");

    made.comment.updatedAt = at(9).toISOString();
    const row = await inboundOf(commentId);
    await p.adapter.processInboundComment((row as NonNullable<typeof row>).id);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toContain(
      "second [s=4]",
    );
  });
});

describe("H2 a confirm always checks the held comment against Linear", () => {
  test("H2 a body changed in Linear with no webhook cancels the hold", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    held.body = "@external rewritten in Linear [s=4]";
    await staff(s, "@confirm", { parentId: held.id });
    const [reply] = await p.repliesFor(s.requestId);
    expect(reply).toMatchObject({
      status: "cancelled",
      cancelReason: "edited",
    });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toEqual([
      "Where is my invoice?",
    ]);
  });

  test("H2 a changed updatedAt with the same body cancels the hold", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    held.updatedAt = new Date(Date.now() + 120_000).toISOString();
    await staff(s, "@confirm", { parentId: held.id });
    expect((await p.repliesFor(s.requestId))[0]?.status).toBe("cancelled");
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
  });

  test("H2 an unchanged held comment is fetched once and then released", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    const spy = spyOn(p.linear, "getComment");
    try {
      await staff(s, "@confirm", { parentId: held.id });
      const ids = spy.mock.calls.map((call) => call[0]);
      expect(ids).toContain(held.id);
    } finally {
      spy.mockRestore();
    }
    expect((await p.repliesFor(s.requestId))[0]?.status).toBe("sent");
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(2);
  });

  test("H2 a deleted held comment cancels the hold", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    p.stub.comments.splice(
      p.stub.comments.findIndex((comment) => comment.id === held.id),
      1,
    );
    await staff(s, "@confirm", { parentId: held.id });
    expect((await p.repliesFor(s.requestId))[0]).toMatchObject({
      status: "cancelled",
      cancelReason: "removed",
    });
  });

  test("H2 a failed fetch keeps the confirm pending and never sends, then retries", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    const spy = spyOn(p.linear, "getComment").mockRejectedValue(
      new Error("linear unavailable"),
    );
    const confirm = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@confirm",
      parentId: held.id,
    });
    try {
      await expect(p.drain(s.requestId)).rejects.toThrow(/linear unavailable/);
    } finally {
      spy.mockRestore();
    }
    expect((await p.repliesFor(s.requestId))[0]?.status).toBe("held");
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
    const pending = await inboundOf(confirm.comment.id);
    expect(pending?.status).toBe("pending");

    await p.adapter.processInboundComment(
      (pending as NonNullable<typeof pending>).id,
    );
    expect((await p.repliesFor(s.requestId))[0]?.status).toBe("sent");
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(2);
  });
});

describe("H3 an update with no updatedAt is treated as refetch_required", () => {
  test("H3 a pending comment is marked for refetch and then processes the current text", async () => {
    const s = await p.scenario();
    const made = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external old words [s=4]",
      deliver: false,
    });
    await persistInboundComment(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId: made.comment.id,
      issueId: s.issueId,
      parentCommentId: null,
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      body: "@external old words [s=4]",
      sourceCreatedAt: new Date(Date.now() - 5000),
      sourceUpdatedAt: new Date(Date.now() - 5000),
    });
    made.comment.body = "@external new words [s=4]";
    const response = await post(
      untimedUpdate(made.comment, "@external new words [s=4]"),
    );
    expect(response).toMatchObject({
      status: "accepted",
      change: "refetch_required",
    });
    expect(await inboundOf(made.comment.id)).toMatchObject({
      body: "@external old words [s=4]",
      refetchRequired: true,
    });
    expect(await changeOf(made.comment.id)).toBeUndefined();
    await p.drain(s.requestId);
    const bodies = bodiesOf(await p.thread(s.who, s.requestId));
    expect(bodies).toContain("new words [s=4]");
    expect(bodies.join("\n")).not.toContain("old words");
  });

  test("H3 an untimed update for an unknown comment records nothing", async () => {
    const s = await p.scenario();
    const made = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external unseen [s=4]",
      deliver: false,
    });
    const response = await post(untimedUpdate(made.comment, "@external x"));
    expect(response).toMatchObject({
      status: "ignored",
      reason: "unknown_comment",
    });
    expect(await changeOf(made.comment.id)).toBeUndefined();
  });

  test("H3 a timed update still orders by its own updatedAt", async () => {
    const s = await p.scenario();
    const made = await p.stub.staffComment({
      issueId: s.issueId,
      body: "@external v1 [s=4]",
      deliver: false,
    });
    const payload = commentWebhookPayload(
      {
        ...made.comment,
        body: "@external v2 [s=4]",
        updatedAt: at(7).toISOString(),
      },
      Date.now(),
      "update",
    );
    expect(await post(payload)).toMatchObject({ status: "ignored" });
    expect((await changeOf(made.comment.id))?.updatedAt.getTime()).toBe(
      at(7).getTime(),
    );
    expect(
      await p.h.db
        .select()
        .from(commentChanges)
        .where(
          and(
            eq(commentChanges.commentId, made.comment.id),
            eq(commentChanges.action, "update"),
          ),
        ),
    ).toHaveLength(1);
  });
});

describe("refresh edge cases", () => {
  const fetchedFor = (issueId: string, updatedAt: Date) => ({
    issueId,
    body: "@external x [s=4]",
    parentCommentId: null,
    authorId: STUB_STAFF_ID,
    authorName: "Ada",
    createdAt: at(1),
    updatedAt,
  });

  async function stored(issueId: string, updatedAt: Date | undefined) {
    const commentId = `edge-${crypto.randomUUID()}`;
    await persistInboundComment(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId,
      issueId,
      parentCommentId: null,
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      body: "@external x [s=4]",
      sourceCreatedAt: at(1),
      sourceUpdatedAt: updatedAt,
    });
    return (await inboundOf(commentId)) as NonNullable<
      Awaited<ReturnType<typeof inboundOf>>
    >;
  }

  test("a fetched comment from another issue is ignored and stripped of text", async () => {
    const s = await p.scenario();
    const row = await stored(s.issueId, at(1));
    const outcome = await applyFetchedComment(
      p.h.db,
      row.id,
      fetchedFor("another-issue", at(2)),
    );
    expect(outcome.status).toBe("issue_mismatch");
    expect(await inboundOf(row.commentId)).toMatchObject({
      status: "processed",
      disposition: "ignored:issue_mismatch",
      body: "",
    });
  });

  test("a removed comment with no hold is marked removed", async () => {
    const s = await p.scenario();
    const row = await stored(s.issueId, at(1));
    await p.h.db
      .update(inboundComments)
      .set({ status: "processed", disposition: "internal" })
      .where(eq(inboundComments.id, row.id));
    expect((await applyFetchedComment(p.h.db, row.id, null)).status).toBe(
      "removed",
    );
  });

  test("a comment with no stored updatedAt needs a refresh once any change is recorded", async () => {
    const s = await p.scenario();
    const row = await stored(s.issueId, undefined);
    expect(await commentNeedsRefresh(p.h.db, row)).toBe(false);
    await p.h.db.insert(commentChanges).values({
      commentId: row.commentId,
      action: "update",
      updatedAt: at(3),
    });
    expect(await commentNeedsRefresh(p.h.db, row)).toBe(true);
  });
});
