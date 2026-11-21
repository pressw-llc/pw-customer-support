import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp, createS3Storage, loadConfig } from "@pw-support/api";
import {
  buildHoldWarning,
  classifyStaffComment,
  createLinearAdapter,
  HOLD_WARNING_PREFIX,
  messageMarker,
  signLinearWebhook,
} from "@pw-support/channels";
import {
  deliverCommentWebhook,
  STUB_STAFF_ID,
  STUB_VIEWER_ID,
  type StubComment,
} from "@pw-support/channels/testing";
import {
  REPLY_HOLD_TTL_SECONDS,
  TICKET_REDELIVERY_BASE_SECONDS,
} from "@pw-support/contracts";
import {
  claimFollowUpRedeliveries,
  confirmHeldReply,
  listFlaggedReplies,
  listHeldReplies,
  messageDeliveries,
  messages as messagesTable,
  persistInboundComment,
  persistInboundMessage,
  upsertCustomer,
} from "@pw-support/db";
import { handleWake } from "@pw-support/triage";
import { eq } from "drizzle-orm";
import {
  createPhase3Harness,
  markedScore,
  type Phase3Harness,
  textScorer,
  WEBHOOK_SECRET,
} from "./phase-3-support";

let p: Phase3Harness;

beforeAll(async () => {
  p = await createPhase3Harness();
});

afterAll(async () => {
  await p.close();
});

async function staff(
  s: { issueId: string; requestId: string },
  body: string,
  options: { userId?: string; userName?: string; parentId?: string } = {},
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

describe("A14 unmarked staff comments never reach the customer", () => {
  test("A14 an unmarked comment stays internal and an @external comment appears and raises unread", async () => {
    const s = await p.scenario();
    await staff(s, "Dave broke the export again, checking the logs");
    let thread = await p.thread(s.who, s.requestId);
    expect(bodiesOf(thread)).toEqual(["Where is my invoice?"]);
    expect(await p.unread(s.who, s.requestId)).toBe(0);
    const internal = (await p.storedMessages(s.requestId)).filter(
      (m) => m.audience === "internal",
    );
    expect(internal).toHaveLength(1);
    expect(internal[0]).toMatchObject({
      originChannel: "linear",
      author: "staff",
      authorName: "Ada Staff",
      body: "Dave broke the export again, checking the logs",
    });

    await staff(s, "@external Thanks for waiting. Your invoice is attached.");
    thread = await p.thread(s.who, s.requestId);
    const reply = thread.messages.at(-1);
    expect(reply).toMatchObject({
      body: "Thanks for waiting. Your invoice is attached.",
      author: "staff",
      authorName: "Ada Staff",
      originChannel: "linear",
      audience: "external",
    });
    expect(await p.unread(s.who, s.requestId)).toBe(1);
    const read = await p.call(s.who, `/requests/${s.requestId}/read`, {
      method: "POST",
    });
    expect(read.status).toBe(200);
    expect(await p.unread(s.who, s.requestId)).toBe(0);
    const types = await p.eventTypes(s.requestId);
    expect(types).toContain("reply.sent");
    expect(types).not.toContain("reply.flagged");
  });

  test("A14 near-miss and unmarked bodies never produce a customer-visible message", async () => {
    const s = await p.scenario();
    const unmarked = [
      "@externally this is fine",
      " > @external quoted",
      "> @external",
      "@External hello",
      "@EXTERNAL hello",
      "​@external zero width space",
      "﻿@external byte order mark",
      " @external no-break space",
      " @external em space",
      "line one\n@external on line two",
      "```\n@external fenced\n```",
      "- @external list item",
      "@ external spaced",
      "@external\u0000nul after marker",
      "@external​zero width after marker",
      "x @external late",
      "external without the at sign",
      "@exter­nal soft hyphen",
      "@external",
      "  @external   ",
    ];
    for (const body of unmarked) await staff(s, body);
    const thread = await p.thread(s.who, s.requestId);
    expect(bodiesOf(thread)).toEqual(["Where is my invoice?"]);
    expect(await p.unread(s.who, s.requestId)).toBe(0);
    const stored = await p.storedMessages(s.requestId);
    expect(stored.filter((m) => m.audience === "internal")).toHaveLength(
      unmarked.length,
    );
    expect(await p.repliesFor(s.requestId)).toHaveLength(0);
  });

  test("A14 the classifier agrees with an independent oracle on random bodies", () => {
    const oracle = /^[ \t\r\n]*@external(?:[ \t\r\n]|$)/;
    let seed = 20260101;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = <T>(items: T[]): T =>
      items[Math.floor(next() * items.length)] as T;
    const prefixes = [
      "",
      " ",
      "\t",
      "\n",
      "\r\n",
      "> ",
      "```\n",
      "​",
      "﻿",
      " ",
      " ",
      "note: ",
      "- ",
      "# ",
    ];
    const markers = [
      "@external",
      "@externally",
      "@External",
      "@exter nal",
      "external",
      "@@external",
      "@external:",
    ];
    const suffixes = ["", " ", "\n", " hello", "\nbody", ":", "x", "​"];
    let external = 0;
    for (let index = 0; index < 3000; index++) {
      const body = `${pick(prefixes)}${pick(markers)}${pick(suffixes)}${pick(["", " tail", "\nmore text"])}`;
      const result = classifyStaffComment(body);
      const text = body.replace(oracle, "").trim();
      const expected = oracle.test(body) && text !== "";
      expect(result.kind === "external").toBe(expected);
      if (result.kind === "external") external++;
    }
    expect(external).toBeGreaterThan(30);
  });
});

describe("A15 the wording gate holds, flags, or sends", () => {
  test("A15 a reply scored 1.9 stays held until its author confirms", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external Fine, whatever. [s=1.9]");
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toEqual([
      "Where is my invoice?",
    ]);
    const [reply] = await p.repliesFor(s.requestId);
    expect(reply).toMatchObject({
      status: "held",
      holdReason: "wording_low",
      flagged: false,
      threadRootId: held.id,
    });
    expect(reply?.wordingScore).toBeCloseTo(1.9, 5);
    const warning = p.stub.comments.find(
      (c) => c.issueId === s.issueId && c.parentId === held.id,
    );
    expect(warning?.userId).toBe(STUB_VIEWER_ID);
    expect(warning?.body).toBe(
      buildHoldWarning({ reason: "wording_low", score: 1.9, maxChars: 10_000 }),
    );
    expect(warning?.body.startsWith(HOLD_WARNING_PREFIX)).toBe(true);
    expect(warning?.body).toContain("1.9 out of 5");
    expect(await p.eventTypes(s.requestId)).toContain("reply.held");
    const judgment = await p.h.db.query.judgments.findFirst({
      where: (j, { and: all, eq: same }) =>
        all(same(j.requestId, s.requestId), same(j.kind, "wording")),
    });
    expect(judgment).toMatchObject({ flagged: true, threshold: 2 });
    expect(judgment?.raw).toMatchObject({ fake: true });

    const stranger = await staff(s, "@confirm", {
      parentId: held.id,
      userId: "user-other",
      userName: "Other Staff",
    });
    expect(stranger.id).toBeTruthy();
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
    expect((await p.repliesFor(s.requestId))[0]?.status).toBe("held");

    await staff(s, "@confirm", { parentId: "some-other-thread" });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);

    await staff(s, "@confirm");
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);

    await staff(s, "@confirm", { parentId: held.id });
    const thread = await p.thread(s.who, s.requestId);
    expect(thread.messages.at(-1)).toMatchObject({
      body: "Fine, whatever. [s=1.9]",
      authorName: "Ada Staff",
      originChannel: "linear",
    });
    const [sent] = await p.repliesFor(s.requestId);
    expect(sent).toMatchObject({ status: "sent", confirmedBy: "Ada Staff" });
    const sends = (await p.eventTypes(s.requestId)).filter(
      (type) => type === "reply.sent",
    );
    expect(sends).toHaveLength(1);

    await staff(s, "@confirm", { parentId: held.id });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(2);
    const dispositions = (await p.inboundFor(s.requestId)).map(
      (row) => row.disposition,
    );
    expect(dispositions).toContain("confirm_ignored:not_author");
    expect(dispositions).toContain("confirm_ignored:no_hold");
    expect(dispositions).toContain("confirm");
  });

  test("A15 a confirm after the hold expires sends nothing", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external meh [s=0.5]");
    p.h.clock.advance(REPLY_HOLD_TTL_SECONDS + 5);
    await staff(s, "@confirm", { parentId: held.id });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
    expect((await p.repliesFor(s.requestId))[0]?.status).toBe("expired");
    expect(await listHeldReplies(p.h.db, s.requestId)).toHaveLength(0);
  });

  test("A15 a confirm releases only the latest held reply of its author in the thread", async () => {
    const s = await p.scenario();
    const root = await staff(s, "@external first [s=1.0]");
    await staff(s, "@external second [s=1.2]", { parentId: root.id });
    await staff(s, "@confirm", { parentId: root.id });
    const thread = await p.thread(s.who, s.requestId);
    expect(bodiesOf(thread)).toEqual([
      "Where is my invoice?",
      "second [s=1.2]",
    ]);
    expect(await listHeldReplies(p.h.db, s.requestId)).toHaveLength(1);
  });

  test("A15 a reply scored 2.5 sends with a flag the admin query returns", async () => {
    const s = await p.scenario();
    await staff(s, "@external Okay, try again. [s=2.5]");
    const thread = await p.thread(s.who, s.requestId);
    expect(thread.messages.at(-1)?.body).toBe("Okay, try again. [s=2.5]");
    expect(await p.unread(s.who, s.requestId)).toBe(1);
    const flagged = await listFlaggedReplies(p.h.db, {
      projectId: s.who.projectId,
    });
    expect(flagged.map((row) => row.reply.requestId)).toEqual([s.requestId]);
    expect(flagged[0]?.reply.wordingScore).toBeCloseTo(2.5, 5);
    const types = await p.eventTypes(s.requestId);
    expect(types).toContain("reply.sent");
    expect(types).toContain("reply.flagged");
    const none = await listFlaggedReplies(p.h.db, {
      projectId: crypto.randomUUID(),
    });
    expect(none).toEqual([]);
  });

  test("A15 a reply scored 3.0 sends without a flag and 2.0 sends with one", async () => {
    const s = await p.scenario();
    await staff(s, "@external Plain good reply. [s=3.0]");
    await staff(s, "@external Boundary reply. [s=2.0]");
    const rows = await p.repliesFor(s.requestId);
    expect(rows.map((row) => [row.status, row.flagged])).toEqual([
      ["sent", false],
      ["sent", true],
    ]);
    const flagged = await listFlaggedReplies(p.h.db, {
      projectId: s.who.projectId,
    });
    expect(flagged).toHaveLength(1);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(3);
  });

  test("A15 a Jev failure holds the reply with a distinct reason and warns the author", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external Please retry now. [s=ERR]");
    const [reply] = await p.repliesFor(s.requestId);
    expect(reply).toMatchObject({
      status: "held",
      holdReason: "wording_unavailable",
    });
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(1);
    const warning = p.stub.comments.find((c) => c.parentId === held.id);
    expect(warning?.body).toContain("The wording check was unavailable.");
    const judgment = await p.h.db.query.judgments.findFirst({
      where: (j, { and: all, eq: same }) =>
        all(same(j.requestId, s.requestId), same(j.kind, "wording")),
    });
    expect(judgment?.raw).toMatchObject({ error: "jev down" });
  });

  test("A15 a missing scorer and an overlong reply both hold", async () => {
    const bare = await createPhase3Harness({ wording: null });
    try {
      const s = await bare.scenario();
      const first = await bare.stub.staffComment({
        issueId: s.issueId,
        body: "@external hello there",
      });
      await bare.drain(s.requestId);
      const long = await bare.stub.staffComment({
        issueId: s.issueId,
        body: `@external ${"x".repeat(10_001)}`,
      });
      await bare.drain(s.requestId);
      const rows = await bare.repliesFor(s.requestId);
      expect(rows.map((row) => row.holdReason)).toEqual([
        "wording_unavailable",
        "too_long",
      ]);
      expect(first.comment.id).not.toBe(long.comment.id);
    } finally {
      await bare.close();
    }
    const scorer = textScorer(() => 5);
    const guarded = await createPhase3Harness({ wording: scorer });
    try {
      const s = await guarded.scenario();
      await guarded.stub.staffComment({
        issueId: s.issueId,
        body: `@external ${"x".repeat(10_001)}`,
      });
      await guarded.drain(s.requestId);
      const [row] = await guarded.repliesFor(s.requestId);
      expect(row?.holdReason).toBe("too_long");
      expect(scorer.calls).toHaveLength(0);
      const warning = guarded.stub.comments.find((c) => c.parentId);
      expect(warning?.body).toContain("longer than 10000 characters");
    } finally {
      await guarded.close();
    }
  });

  test("A15 a scorer that returns a non finite score holds the reply", async () => {
    const odd = await createPhase3Harness({
      wording: textScorer(() => Number.NaN),
    });
    try {
      const s = await odd.scenario();
      await odd.stub.staffComment({
        issueId: s.issueId,
        body: "@external hello",
      });
      await odd.drain(s.requestId);
      expect((await odd.repliesFor(s.requestId))[0]?.holdReason).toBe(
        "wording_unavailable",
      );
    } finally {
      await odd.close();
    }
  });

  test("A15 own comments never loop: warnings and follow-up comments are ignored", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external rough text [s=1.0]");
    await p.waitFor(() => {
      const warning = p.stub.comments.find((c) => c.parentId === held.id);
      return p.stub.deliveries.some((d) => d.commentId === warning?.id);
    });
    await p.drain(s.requestId);
    const rows = await p.inboundFor(s.requestId);
    const own = rows.filter((row) => row.disposition === "own_comment");
    expect(own.length).toBeGreaterThanOrEqual(1);
    expect(
      (await p.storedMessages(s.requestId)).filter(
        (m) => m.audience === "internal",
      ),
    ).toHaveLength(0);
  });
});

describe("A16 customer follow-ups reach the Linear ticket", () => {
  test("A16 a widget follow-up becomes one quoted comment on the ticket", async () => {
    const s = await p.scenario();
    const sent = await p.followUp(
      s.who,
      s.requestId,
      "Adding order 4412\n@everyone [click](https://evil.example)",
    );
    await p.drain(s.requestId);
    await p.drain(s.requestId);
    const comments = p.stub.comments.filter(
      (c) => c.issueId === s.issueId && c.userId === STUB_VIEWER_ID,
    );
    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? "";
    expect(
      body.startsWith("Customer follow-up via widget\n\n> Adding order 4412"),
    ).toBe(true);
    expect(body).not.toContain("](https://");
    expect(body).not.toContain("@everyone");
    expect(body.endsWith(messageMarker(sent.message.id))).toBe(true);
    const [delivery] = await p.h.db
      .select()
      .from(messageDeliveries)
      .where(eq(messageDeliveries.messageId, sent.message.id));
    expect(delivery).toMatchObject({ via: "comment" });
    expect(delivery?.linearCommentId).toBe(comments[0]?.id as string);
    expect(await p.adapter.syncFollowUps(s.requestId)).toBe(0);
    expect(
      p.stub.comments.filter(
        (c) => c.userId === STUB_VIEWER_ID && c.issueId === s.issueId,
      ),
    ).toHaveLength(1);
  });

  test("A16 comments keep the order of the follow-ups and list attachment names", async () => {
    const s = await p.scenario();
    const first = await p.followUp(s.who, s.requestId, "first follow-up");
    const second = await p.followUp(s.who, s.requestId, "second follow-up");
    await p.drain(s.requestId);
    const bodies = p.stub.comments
      .filter((c) => c.issueId === s.issueId)
      .map((c) => c.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("first follow-up");
    expect(bodies[1]).toContain("second follow-up");
    expect(bodies[0]?.endsWith(messageMarker(first.message.id))).toBe(true);
    expect(bodies[1]?.endsWith(messageMarker(second.message.id))).toBe(true);

    const form = new FormData();
    form.set("text", "see the log");
    form.append(
      "files",
      new File(["boom\n"], "app.log", { type: "text/plain" }),
    );
    await p.app.request(`/v1/requests/${s.requestId}/messages`, {
      method: "POST",
      headers: s.who.headers,
      body: form,
    });
    await p.drain(s.requestId);
    const last = p.stub.comments.filter((c) => c.issueId === s.issueId).at(-1);
    expect(last?.body).toContain("Attachments:\n- `app.log`");
  });

  test("A16 a follow-up that lands during ticket creation is delivered after ticket.created", async () => {
    const who = await p.h.tenant({ teamId: p.stub.teams[0]?.id });
    const submitted = await p.h.submit(who, "Original problem text");
    p.h.clock.advance(61);
    await handleWake(p.h.deps, submitted.jobId);
    const early = await p.adapter.syncFollowUps(submitted.requestId);
    expect(early).toBe(0);
    let injected: string | undefined;
    const racing = {
      ...p.linear,
      async createIssue(input: Parameters<typeof p.linear.createIssue>[0]) {
        const issue = await p.linear.createIssue(input);
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
          requestId: submitted.requestId,
          body: "late follow-up during creation",
        });
        injected = result?.message.id;
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
    const issueId =
      outcome.status === "created" ? outcome.ticket.linearIssueId : "";
    expect(p.stub.comments.filter((c) => c.issueId === issueId)).toHaveLength(
      0,
    );
    expect(await p.eventTypes(submitted.requestId)).toContain("ticket.created");
    await p.drain(submitted.requestId);
    const comments = p.stub.comments.filter((c) => c.issueId === issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("late follow-up during creation");
    expect(comments[0]?.body.endsWith(messageMarker(injected as string))).toBe(
      true,
    );
    const issue = p.stub.issues.find((i) => i.id === issueId);
    expect(issue?.description).toContain("Original problem text");
    expect(issue?.description).not.toContain("late follow-up");
  });

  test("A16 a follow-up already in the ticket description is not posted again", async () => {
    const who = await p.h.tenant({ teamId: p.stub.teams[0]?.id });
    const submitted = await p.h.submit(who, "Original text");
    const form = new FormData();
    form.set("text", "second message before triage");
    await p.app.request(`/v1/requests/${submitted.requestId}/messages`, {
      method: "POST",
      headers: who.headers,
      body: form,
    });
    p.h.clock.advance(61);
    await handleWake(p.h.deps, submitted.jobId);
    const outcome = await p.adapter.createTicketForRequest(submitted.requestId);
    expect(outcome.status).toBe("created");
    await p.drain(submitted.requestId);
    const issueId =
      outcome.status === "created" ? outcome.ticket.linearIssueId : "";
    expect(p.stub.comments.filter((c) => c.issueId === issueId)).toHaveLength(
      0,
    );
    expect(p.stub.issues.find((i) => i.id === issueId)?.description).toContain(
      "second message before triage",
    );
  });

  test("A16 a failed delivery is retried with backoff and posts one comment", async () => {
    const s = await p.scenario();
    const sent = await p.followUp(s.who, s.requestId, "retry me");
    p.stub.failNext(100_000);
    const events = await p.drain(s.requestId).catch((error: unknown) => error);
    expect(events).toBeInstanceOf(Error);
    p.stub.failNext(0);
    expect(p.stub.comments.filter((c) => c.issueId === s.issueId)).toHaveLength(
      0,
    );

    const due = await claimFollowUpRedeliveries(p.h.db, {
      now: p.h.clock.now(),
      requestId: s.requestId,
    });
    expect(due.map((event) => event.type)).toEqual(["message.created"]);
    const again = await claimFollowUpRedeliveries(p.h.db, {
      now: p.h.clock.now(),
      requestId: s.requestId,
    });
    expect(again).toEqual([]);
    p.h.clock.advance(TICKET_REDELIVERY_BASE_SECONDS + 1);
    expect(
      await claimFollowUpRedeliveries(p.h.db, {
        now: p.h.clock.now(),
        requestId: s.requestId,
      }),
    ).toEqual([]);
    p.h.clock.advance(TICKET_REDELIVERY_BASE_SECONDS + 1);
    const second = await claimFollowUpRedeliveries(p.h.db, {
      now: p.h.clock.now(),
      requestId: s.requestId,
    });
    expect(second).toHaveLength(1);
    await p.h.db
      .update(messageDeliveries)
      .set({ lastEnqueuedAt: null, deliveryAttempts: 0 })
      .where(eq(messageDeliveries.messageId, sent.message.id));
    const due2 = second;
    for (const event of due2)
      await p.adapter.handle(event, { now: p.h.clock.now });
    const comments = p.stub.comments.filter((c) => c.issueId === s.issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body.endsWith(messageMarker(sent.message.id))).toBe(
      true,
    );
    p.h.clock.advance(100_000);
    expect(
      await claimFollowUpRedeliveries(p.h.db, {
        now: p.h.clock.now(),
        requestId: s.requestId,
      }),
    ).toEqual([]);
  });

  test("A16 a comment created before a crash is found by its marker and not posted twice", async () => {
    const s = await p.scenario();
    const sent = await p.followUp(s.who, s.requestId, "crash window");
    await p.linear.createComment(
      s.issueId,
      `earlier attempt\n\n${messageMarker(sent.message.id)}`,
    );
    await p.drain(s.requestId);
    const withMarker = p.stub.comments.filter(
      (c) =>
        c.issueId === s.issueId &&
        c.body.endsWith(messageMarker(sent.message.id)),
    );
    expect(withMarker).toHaveLength(1);
    const [delivery] = await p.h.db
      .select()
      .from(messageDeliveries)
      .where(eq(messageDeliveries.messageId, sent.message.id));
    expect(delivery?.linearCommentId).toBe(withMarker[0]?.id as string);
  });

  test("A16 a message whose intake has not finished waits for the grace period", async () => {
    const s = await p.scenario();
    const sent = await p.followUp(s.who, s.requestId, "slow intake");
    await p.h.db
      .update(messagesTable)
      .set({ intakeCompletedAt: null, createdAt: p.h.clock.now() })
      .where(eq(messagesTable.id, sent.message.id));
    expect(await p.adapter.syncFollowUps(s.requestId)).toBe(0);
    p.h.clock.advance(301);
    expect(await p.adapter.syncFollowUps(s.requestId)).toBe(1);
  });
});

describe("webhook security", () => {
  const body = "@external Hello from staff";

  async function send(
    s: { issueId: string },
    overrides: Parameters<typeof deliverCommentWebhook>[2] = {},
    text = body,
  ) {
    const comment: StubComment = {
      id: crypto.randomUUID(),
      issueId: s.issueId,
      body: text,
      userId: STUB_STAFF_ID,
      userName: "Ada Staff",
      parentId: null,
    };
    const delivery = await deliverCommentWebhook(
      { url: p.webhookUrl, secret: WEBHOOK_SECRET },
      comment,
      overrides,
    );
    return { comment, delivery };
  }

  test("a bad or missing signature returns 401 and stores nothing", async () => {
    const s = await p.scenario();
    const wrong = await send(s, { secret: "another-secret" });
    const missing = await send(s, { signature: null });
    const malformed = await send(s, { signature: "zz" });
    const short = await send(s, { signature: "ab".repeat(10) });
    for (const result of [wrong, missing, malformed, short]) {
      expect(result.delivery.status).toBe(401);
    }
    expect(await p.inboundFor(s.requestId)).toHaveLength(0);
  });

  test("a stale or future timestamp returns 401", async () => {
    const s = await p.scenario();
    const stale = await send(s, { timestamp: Date.now() - 61_000 });
    const future = await send(s, { timestamp: Date.now() + 120_000 });
    expect(stale.delivery.status).toBe(401);
    expect(stale.delivery.body).toContain("stale_timestamp");
    expect(future.delivery.status).toBe(401);
    expect(await p.inboundFor(s.requestId)).toHaveLength(0);
  });

  test("a replayed delivery id is acknowledged and processed once", async () => {
    const s = await p.scenario();
    const deliveryId = crypto.randomUUID();
    const first = await send(s, { deliveryId });
    const second = await send(s, { deliveryId });
    expect(first.delivery.status).toBe(200);
    expect(second.delivery.status).toBe(200);
    expect(second.delivery.body).toContain("duplicate_delivery");
    expect(await p.inboundFor(s.requestId)).toHaveLength(1);
  });

  test("a repeated comment id under a new delivery id is stored once", async () => {
    const s = await p.scenario();
    const first = await send(s);
    const again = await deliverCommentWebhook(
      { url: p.webhookUrl, secret: WEBHOOK_SECRET },
      first.comment,
    );
    expect(again.body).toContain("duplicate_comment");
    expect(await p.inboundFor(s.requestId)).toHaveLength(1);
  });

  test("an oversized body returns 413", async () => {
    const s = await p.scenario();
    const big = await send(s, {}, `@external ${"y".repeat(300 * 1024)}`);
    expect(big.delivery.status).toBe(413);
    expect(await p.inboundFor(s.requestId)).toHaveLength(0);
  });

  test("a missing delivery header returns 400", async () => {
    const s = await p.scenario();
    const result = await send(s, { omitDelivery: true });
    expect(result.delivery.status).toBe(400);
    expect(await p.inboundFor(s.requestId)).toHaveLength(0);
  });

  test("a signed body that is not valid JSON or has the wrong shape returns 400", async () => {
    const s = await p.scenario();
    const notJson = await send(s, { rawBody: "not json" });
    const wrongShape = await send(s, { rawBody: JSON.stringify({ type: 3 }) });
    expect(notJson.delivery.status).toBe(400);
    expect(wrongShape.delivery.status).toBe(400);
    const invalidUtf8 = await fetch(p.webhookUrl, {
      method: "POST",
      headers: {
        "Linear-Delivery": crypto.randomUUID(),
        "Linear-Signature": signLinearWebhook(
          WEBHOOK_SECRET,
          new Uint8Array([0xff, 0xfe, 0x7b]),
        ),
      },
      body: new Uint8Array([0xff, 0xfe, 0x7b]),
    });
    expect(invalidUtf8.status).toBe(400);
  });

  test("a comment on an unknown issue is ignored", async () => {
    const s = await p.scenario();
    const result = await send({ issueId: "issue-not-ours" });
    expect(result.delivery.status).toBe(200);
    expect(result.delivery.body).toContain("unknown_issue");
    expect(await p.inboundFor(s.requestId)).toHaveLength(0);
  });

  test("other event types and comment updates are ignored", async () => {
    const s = await p.scenario();
    const comment = {
      id: crypto.randomUUID(),
      issueId: s.issueId,
      body,
      userId: STUB_STAFF_ID,
      userName: "Ada",
      parentId: null,
    };
    const post = async (payload: Record<string, unknown>) => {
      const raw = JSON.stringify(payload);
      return fetch(p.webhookUrl, {
        method: "POST",
        headers: {
          "Linear-Delivery": crypto.randomUUID(),
          "Linear-Signature": signLinearWebhook(WEBHOOK_SECRET, raw),
        },
        body: raw,
      });
    };
    const base = { webhookTimestamp: Date.now(), data: comment };
    const update = await post({ ...base, action: "update", type: "Comment" });
    const issue = await post({ ...base, action: "create", type: "Issue" });
    const noIssue = await post({
      ...base,
      action: "create",
      type: "Comment",
      data: { id: "c1", body: "project comment" },
    });
    for (const response of [update, issue, noIssue]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ignored" });
    }
    expect(await p.inboundFor(s.requestId)).toHaveLength(0);
  });

  test("a comment by the integration itself is stored and then ignored", async () => {
    const s = await p.scenario();
    const own = await send(s, {}, "@external pretend to be a staff reply");
    expect(own.delivery.status).toBe(200);
    const raw = await p.inboundFor(s.requestId);
    expect(raw).toHaveLength(1);
    const viewerComment: StubComment = {
      ...own.comment,
      id: crypto.randomUUID(),
      userId: STUB_VIEWER_ID,
    };
    await deliverCommentWebhook(
      { url: p.webhookUrl, secret: WEBHOOK_SECRET },
      viewerComment,
    );
    await p.drain(s.requestId);
    const rows = await p.inboundFor(s.requestId);
    const byViewer = rows.find((row) => row.commentId === viewerComment.id);
    expect(byViewer?.disposition).toBe("own_comment");
    expect(await p.repliesFor(s.requestId)).toHaveLength(1);
    expect(bodiesOf(await p.thread(s.who, s.requestId))).toHaveLength(2);
  });

  test("a missing secret fails closed and stores nothing", async () => {
    const closed = await createPhase3Harness({ secret: null });
    try {
      const s = await closed.scenario();
      const comment: StubComment = {
        id: crypto.randomUUID(),
        issueId: s.issueId,
        body,
        userId: STUB_STAFF_ID,
        userName: "Ada",
        parentId: null,
      };
      const result = await deliverCommentWebhook(
        { url: closed.webhookUrl, secret: WEBHOOK_SECRET },
        comment,
      );
      expect(result.status).toBe(503);
      expect(await closed.inboundFor(s.requestId)).toHaveLength(0);
    } finally {
      await closed.close();
    }
  });

  test("an API with no webhook intake answers 503", async () => {
    const config = loadConfig({});
    const bare = createApp({
      db: p.h.db,
      storage: createS3Storage(config),
      config,
    });
    const response = await bare.request("/webhooks/linear", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(503);
  });
});

describe("confirm without a thread", () => {
  test("a confirm comment with no parent thread is ignored", async () => {
    const s = await p.scenario();
    const stored = await persistInboundComment(p.h.db, {
      deliveryId: crypto.randomUUID(),
      commentId: crypto.randomUUID(),
      issueId: s.issueId,
      parentCommentId: null,
      authorId: STUB_STAFF_ID,
      authorName: "Ada",
      body: "@confirm",
    });
    expect(stored.status).toBe("stored");
    const inboundId = stored.status === "stored" ? stored.inbound.id : "";
    const result = await confirmHeldReply(p.h.db, { inboundId });
    expect(result).toEqual({ outcome: "ignored", reason: "no_thread" });
    expect(await confirmHeldReply(p.h.db, { inboundId })).toBeNull();
  });
});

describe("staff display and wording helpers", () => {
  test("the staff display name is plain text from the webhook payload", async () => {
    const s = await p.scenario();
    await staff(s, "@external Hello. [s=4]", {
      userName: "<b>Eve</b>‮ Mallory",
    });
    const thread = await p.thread(s.who, s.requestId);
    expect(thread.messages.at(-1)?.authorName).toBe("<b>Eve</b> Mallory");
    expect(markedScore("[s=3]")).toBe(3);
    expect(markedScore("none")).toBe(4);
  });
});
