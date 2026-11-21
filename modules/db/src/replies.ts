import {
  MESSAGE_INTAKE_GRACE_SECONDS,
  ORPHAN_COMMENT_TTL_SECONDS,
  REPLY_HOLD_TTL_SECONDS,
  type ReplyBand,
  type ReplyCancelReason,
  type ReplyHoldReason,
  WORDING_HOLD_BELOW,
} from "@pw-support/contracts";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { inTransaction, type SupportExecutor, type SupportTx } from "./client";
import { appendEvent } from "./events";
import {
  attachments,
  commentChanges,
  inboundComments,
  judgments,
  messageDeliveries,
  messages,
  replies,
  requests,
  tickets,
  webhookDeliveries,
} from "./schema";
import type { TicketRow } from "./triage-data";

export type InboundCommentRow = typeof inboundComments.$inferSelect;
export type ReplyRow = typeof replies.$inferSelect;
export type MessageRecord = typeof messages.$inferSelect;
export type RequestRecord = typeof requests.$inferSelect;

export const WORDING_JUDGMENT_KIND = "wording";
const PROVIDER = "linear";

function required<T>(row: T | undefined): T {
  if (row === undefined) throw new Error("expected a row");
  return row;
}

export async function findTicketByLinearIssue(
  db: SupportExecutor,
  issueId: string,
): Promise<{ ticket: TicketRow; request: RequestRecord } | null> {
  const [row] = await db
    .select({ ticket: tickets, request: requests })
    .from(tickets)
    .innerJoin(requests, eq(requests.id, tickets.requestId))
    .where(eq(tickets.linearIssueId, issueId));
  return row ?? null;
}

export interface InboundCommentInput {
  deliveryId: string;
  commentId: string;
  issueId: string;
  parentCommentId: string | null;
  authorId: string | null;
  authorName: string | null;
  body: string;
  sourceCreatedAt: Date;
  sourceUpdatedAt?: Date | null;
}

export type InboundCommentResult =
  | { status: "stored"; inbound: InboundCommentRow }
  | { status: "awaiting_ticket"; inbound: InboundCommentRow }
  | { status: "superseded" }
  | { status: "duplicate_delivery" }
  | { status: "duplicate_comment" };

async function insertDelivery(
  tx: SupportTx,
  deliveryId: string,
): Promise<boolean> {
  const rows = await tx
    .insert(webhookDeliveries)
    .values({ deliveryId, provider: PROVIDER })
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.deliveryId });
  return rows.length > 0;
}

async function lockComment(tx: SupportTx, commentId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${PROVIDER}:${commentId}`}, 19))`,
  );
}

type CommentChangeRow = typeof commentChanges.$inferSelect;

async function recordChange(
  tx: SupportTx,
  input: { commentId: string; action: "update" | "remove"; updatedAt: Date },
): Promise<void> {
  await tx
    .insert(commentChanges)
    .values({
      provider: PROVIDER,
      commentId: input.commentId,
      action: input.action,
      updatedAt: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: [commentChanges.provider, commentChanges.commentId],
      set: {
        action: sql`CASE WHEN ${commentChanges.action} = 'remove' OR EXCLUDED.action = 'remove' THEN 'remove' ELSE 'update' END`,
        updatedAt: sql`GREATEST(${commentChanges.updatedAt}, EXCLUDED.updated_at)`,
        recordedAt: sql`now()`,
      },
    });
}

async function changeFor(
  tx: SupportTx,
  commentId: string,
): Promise<CommentChangeRow | null> {
  const [row] = await tx
    .select()
    .from(commentChanges)
    .where(
      and(
        eq(commentChanges.provider, PROVIDER),
        eq(commentChanges.commentId, commentId),
      ),
    );
  return row ?? null;
}

function supersedes(
  change: CommentChangeRow,
  sourceUpdatedAt: Date | null,
): boolean {
  return (
    change.action === "remove" ||
    sourceUpdatedAt === null ||
    change.updatedAt.getTime() > sourceUpdatedAt.getTime()
  );
}

export async function persistInboundComment(
  db: SupportExecutor,
  input: InboundCommentInput,
): Promise<InboundCommentResult> {
  return inTransaction(db, async (tx) => {
    if (!(await insertDelivery(tx, input.deliveryId))) {
      return { status: "duplicate_delivery" };
    }
    await lockComment(tx, input.commentId);
    const sourceUpdatedAt = input.sourceUpdatedAt ?? null;
    const change = await changeFor(tx, input.commentId);
    const superseded = change ? supersedes(change, sourceUpdatedAt) : false;
    if (change?.action === "remove") return { status: "superseded" };
    const found = await findTicketByLinearIssue(tx, input.issueId);
    const trusted = found !== null && !superseded;
    const [inbound] = await tx
      .insert(inboundComments)
      .values({
        provider: PROVIDER,
        commentId: input.commentId,
        issueId: input.issueId,
        parentCommentId: input.parentCommentId,
        authorId: trusted ? input.authorId : null,
        authorName: trusted ? input.authorName : null,
        body: trusted ? input.body : "",
        sourceCreatedAt: input.sourceCreatedAt,
        sourceUpdatedAt: trusted ? sourceUpdatedAt : null,
        refetchRequired: !trusted,
        requestId: found?.request.id ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!inbound) return { status: "duplicate_comment" };
    if (!found) return { status: "awaiting_ticket", inbound };
    await appendCommentReceived(tx, found.request, inbound);
    return { status: "stored", inbound };
  });
}

export async function appendCommentReceived(
  tx: SupportTx,
  request: RequestRecord,
  inbound: InboundCommentRow,
): Promise<void> {
  await appendEvent(tx, {
    type: "comment.received",
    channelKey: request.channelKey,
    requestId: request.id,
    payload: {
      inboundId: inbound.id,
      commentId: inbound.commentId,
      issueId: inbound.issueId,
    },
  });
}

export interface CommentChangeInput {
  deliveryId: string;
  commentId: string;
  action: "update" | "remove";
  body?: string;
  updatedAt?: Date;
}

export type CommentChangeResult =
  | { status: "duplicate_delivery" }
  | { status: "unknown_comment" }
  | { status: "unchanged" }
  | { status: "stale" }
  | { status: "updated" }
  | { status: "removed" }
  | { status: "cancelled"; reply: ReplyRow };

export async function cancelHeldReplyFor(
  tx: SupportTx,
  inbound: InboundCommentRow,
  reason: ReplyCancelReason,
): Promise<ReplyRow | null> {
  const [held] = await tx
    .select()
    .from(replies)
    .where(
      and(eq(replies.inboundCommentId, inbound.id), eq(replies.status, "held")),
    )
    .for("update");
  if (!held || !inbound.requestId) return null;
  const [cancelled] = await tx
    .update(replies)
    .set({ status: "cancelled", cancelReason: reason })
    .where(eq(replies.id, held.id))
    .returning();
  const request = await requestFor(tx, inbound.requestId);
  await appendEvent(tx, {
    type: "reply.cancelled",
    channelKey: request.channelKey,
    requestId: request.id,
    payload: {
      replyId: held.id,
      inboundCommentId: inbound.id,
      reason,
    },
  });
  return required(cancelled);
}

export async function applyCommentChange(
  db: SupportExecutor,
  input: CommentChangeInput,
): Promise<CommentChangeResult> {
  return inTransaction(db, async (tx) => {
    if (!(await insertDelivery(tx, input.deliveryId))) {
      return { status: "duplicate_delivery" };
    }
    await lockComment(tx, input.commentId);
    const updatedAt = input.updatedAt ?? new Date();
    const [inbound] = await tx
      .select()
      .from(inboundComments)
      .where(
        and(
          eq(inboundComments.provider, PROVIDER),
          eq(inboundComments.commentId, input.commentId),
        ),
      )
      .for("update");
    if (!inbound) {
      await recordChange(tx, {
        commentId: input.commentId,
        action: input.action,
        updatedAt,
      });
      return { status: "unknown_comment" };
    }
    if (input.action === "remove") {
      if (inbound.status === "pending") {
        if (!inbound.requestId) {
          await tx
            .delete(inboundComments)
            .where(eq(inboundComments.id, inbound.id));
          await recordChange(tx, {
            commentId: input.commentId,
            action: "remove",
            updatedAt,
          });
          return { status: "removed" };
        }
        await tx
          .update(inboundComments)
          .set({
            status: "processed",
            disposition: "removed",
            body: "",
            refetchRequired: false,
            processedAt: sql`now()`,
          })
          .where(eq(inboundComments.id, inbound.id));
        return { status: "removed" };
      }
      const cancelled = await cancelHeldReplyFor(tx, inbound, "removed");
      return cancelled
        ? { status: "cancelled", reply: cancelled }
        : { status: "unchanged" };
    }
    const stored = inbound.sourceUpdatedAt;
    if (stored && updatedAt.getTime() <= stored.getTime()) {
      return { status: "stale" };
    }
    if (inbound.refetchRequired || input.body === undefined) {
      return { status: "unchanged" };
    }
    const edited = input.body !== inbound.body;
    await tx
      .update(inboundComments)
      .set({ body: input.body, sourceUpdatedAt: updatedAt })
      .where(eq(inboundComments.id, inbound.id));
    if (!edited) return { status: "unchanged" };
    if (inbound.status === "pending") return { status: "updated" };
    const cancelled = await cancelHeldReplyFor(tx, inbound, "edited");
    return cancelled
      ? { status: "cancelled", reply: cancelled }
      : { status: "unchanged" };
  });
}

export async function getInboundComment(
  db: SupportExecutor,
  id: string,
): Promise<InboundCommentRow | null> {
  const [row] = await db
    .select()
    .from(inboundComments)
    .where(eq(inboundComments.id, id));
  return row ?? null;
}

export async function getReplyByInbound(
  db: SupportExecutor,
  inboundId: string,
): Promise<ReplyRow | null> {
  const [row] = await db
    .select()
    .from(replies)
    .where(eq(replies.inboundCommentId, inboundId));
  return row ?? null;
}

export async function isRecordedOwnComment(
  db: SupportExecutor,
  commentId: string,
): Promise<boolean> {
  const [delivery] = await db
    .select({ id: messageDeliveries.messageId })
    .from(messageDeliveries)
    .where(eq(messageDeliveries.linearCommentId, commentId))
    .limit(1);
  if (delivery) return true;
  const [warning] = await db
    .select({ id: replies.id })
    .from(replies)
    .where(
      or(
        eq(replies.warningCommentId, commentId),
        eq(replies.cancelNoticeCommentId, commentId),
      ),
    )
    .limit(1);
  return warning !== undefined;
}

async function lockPending(
  tx: SupportTx,
  inboundId: string,
): Promise<InboundCommentRow | null> {
  const [row] = await tx
    .select()
    .from(inboundComments)
    .where(
      and(
        eq(inboundComments.id, inboundId),
        eq(inboundComments.status, "pending"),
        eq(inboundComments.refetchRequired, false),
      ),
    )
    .for("update");
  return row ?? null;
}

async function markProcessed(
  tx: SupportTx,
  inboundId: string,
  disposition: string,
  messageId: string | null = null,
): Promise<void> {
  await tx
    .update(inboundComments)
    .set({
      status: "processed",
      disposition,
      messageId,
      processedAt: sql`now()`,
    })
    .where(eq(inboundComments.id, inboundId));
}

export async function ignoreInboundComment(
  db: SupportExecutor,
  inboundId: string,
  disposition: string,
): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    if (!(await lockPending(tx, inboundId))) return false;
    await markProcessed(tx, inboundId, disposition);
    return true;
  });
}

function displayTime(date: Date) {
  return sql`LEAST(${date.toISOString()}::timestamptz, clock_timestamp())`;
}

export async function storeInternalComment(
  db: SupportExecutor,
  inboundId: string,
): Promise<MessageRecord | null> {
  return inTransaction(db, async (tx) => {
    const inbound = await lockPending(tx, inboundId);
    if (!inbound?.requestId) return null;
    const [message] = await tx
      .insert(messages)
      .values({
        requestId: inbound.requestId,
        body: inbound.body,
        originChannel: "linear",
        author: "staff",
        authorName: inbound.authorName,
        audience: "internal",
        createdAt: displayTime(inbound.sourceCreatedAt),
      })
      .returning();
    const stored = required(message);
    await markProcessed(tx, inboundId, "internal", stored.id);
    return stored;
  });
}

async function releaseReply(
  tx: SupportTx,
  input: {
    request: RequestRecord;
    body: string;
    authorName: string | null;
    displayAt: Date;
  },
): Promise<MessageRecord> {
  const [message] = await tx
    .insert(messages)
    .values({
      requestId: input.request.id,
      body: input.body,
      originChannel: "linear",
      author: "staff",
      authorName: input.authorName,
      audience: "external",
      createdAt: displayTime(input.displayAt),
    })
    .returning();
  await tx
    .update(requests)
    .set({ updatedAt: sql`now()` })
    .where(eq(requests.id, input.request.id));
  return required(message);
}

async function requestFor(
  tx: SupportTx,
  requestId: string,
): Promise<RequestRecord> {
  const [request] = await tx
    .select()
    .from(requests)
    .where(eq(requests.id, requestId));
  return required(request);
}

export interface ExternalReplyInput {
  inboundId: string;
  sourceBody: string;
  text: string;
  score: number;
  band: ReplyBand;
  holdReason?: ReplyHoldReason;
  raw: Record<string, unknown>;
  now?: Date;
  holdTtlSeconds?: number;
}

export interface ExternalReplyResult {
  reply: ReplyRow;
  message: MessageRecord | null;
}

export async function resolveExternalReply(
  db: SupportExecutor,
  input: ExternalReplyInput,
): Promise<ExternalReplyResult | null> {
  return inTransaction(db, async (tx) => {
    const inbound = await lockPending(tx, input.inboundId);
    if (!inbound?.requestId || inbound.body !== input.sourceBody) return null;
    const request = await requestFor(tx, inbound.requestId);
    const now = input.now ?? new Date();
    const ttl = input.holdTtlSeconds ?? REPLY_HOLD_TTL_SECONDS;
    await tx.insert(judgments).values({
      requestId: request.id,
      kind: WORDING_JUDGMENT_KIND,
      subject: `comment:${inbound.commentId}`,
      score: input.score,
      threshold: WORDING_HOLD_BELOW,
      flagged: input.band !== "send",
      raw: input.raw,
    });
    const threadRoot = inbound.parentCommentId ?? inbound.commentId;
    const base = {
      requestId: request.id,
      inboundCommentId: inbound.id,
      threadRootId: threadRoot,
      authorId: inbound.authorId,
      authorName: inbound.authorName,
      body: input.text,
      wordingScore: input.score,
    };
    if (input.band === "hold") {
      const expiresAt = new Date(now.getTime() + ttl * 1000);
      const [reply] = await tx
        .insert(replies)
        .values({
          ...base,
          status: "held",
          holdReason: input.holdReason ?? "wording_low",
          heldAt: now,
          expiresAt,
        })
        .returning();
      const held = required(reply);
      await appendEvent(tx, {
        type: "reply.held",
        channelKey: request.channelKey,
        requestId: request.id,
        payload: {
          replyId: held.id,
          inboundCommentId: inbound.id,
          score: input.score,
          reason: held.holdReason,
          expiresAt: expiresAt.toISOString(),
        },
      });
      await markProcessed(tx, inbound.id, "held");
      return { reply: held, message: null };
    }
    const flagged = input.band === "send_flag";
    const message = await releaseReply(tx, {
      request,
      body: input.text,
      authorName: inbound.authorName,
      displayAt: inbound.sourceCreatedAt,
    });
    const [reply] = await tx
      .insert(replies)
      .values({
        ...base,
        status: "sent",
        flagged,
        messageId: message.id,
        sentAt: now,
      })
      .returning();
    const sent = required(reply);
    await appendEvent(tx, {
      type: "reply.sent",
      channelKey: request.channelKey,
      requestId: request.id,
      payload: {
        replyId: sent.id,
        messageId: message.id,
        score: input.score,
        flagged,
      },
    });
    if (flagged) {
      await appendEvent(tx, {
        type: "reply.flagged",
        channelKey: request.channelKey,
        requestId: request.id,
        payload: {
          replyId: sent.id,
          messageId: message.id,
          score: input.score,
        },
      });
    }
    await markProcessed(
      tx,
      inbound.id,
      flagged ? "sent_flagged" : "sent",
      message.id,
    );
    return { reply: sent, message };
  });
}

export type ConfirmOutcome =
  | { outcome: "sent"; reply: ReplyRow; message: MessageRecord }
  | { outcome: "ignored"; reason: string }
  | { outcome: "deferred"; reason: string };

export async function confirmHeldReply(
  db: SupportExecutor,
  input: { inboundId: string; sourceBody: string; now?: Date },
): Promise<ConfirmOutcome | null> {
  return inTransaction(db, async (tx) => {
    const inbound = await lockPending(tx, input.inboundId);
    if (!inbound || inbound.body !== input.sourceBody) return null;
    const now = input.now ?? new Date();
    const ignore = async (reason: string): Promise<ConfirmOutcome> => {
      await markProcessed(tx, inbound.id, `confirm_ignored:${reason}`);
      return { outcome: "ignored", reason };
    };
    const defer = (reason: string): ConfirmOutcome => ({
      outcome: "deferred",
      reason,
    });
    const parent = inbound.parentCommentId;
    if (!inbound.requestId) return defer("awaiting_ticket");
    if (!parent) return ignore("no_thread");
    const [earlierPending] = await tx
      .select({ id: inboundComments.id })
      .from(inboundComments)
      .where(
        and(
          eq(inboundComments.requestId, inbound.requestId),
          ne(inboundComments.id, inbound.id),
          eq(inboundComments.status, "pending"),
          lt(inboundComments.sourceCreatedAt, inbound.sourceCreatedAt),
          or(
            eq(inboundComments.commentId, parent),
            eq(inboundComments.parentCommentId, parent),
          ),
        ),
      )
      .limit(1);
    if (earlierPending) return defer("thread_pending");
    const candidates = await tx
      .select({ id: replies.id })
      .from(replies)
      .innerJoin(
        inboundComments,
        eq(inboundComments.id, replies.inboundCommentId),
      )
      .where(
        and(
          eq(replies.requestId, inbound.requestId),
          eq(replies.threadRootId, parent),
          eq(replies.status, "held"),
          lt(inboundComments.sourceCreatedAt, inbound.sourceCreatedAt),
        ),
      )
      .orderBy(desc(inboundComments.sourceCreatedAt), desc(replies.id));
    const locked = await tx
      .select()
      .from(replies)
      .where(
        and(
          inArray(
            replies.id,
            candidates.map((row) => row.id),
          ),
          eq(replies.status, "held"),
        ),
      )
      .for("update");
    const byId = new Map(locked.map((row) => [row.id, row]));
    const held = candidates
      .map((row) => byId.get(row.id))
      .filter((row): row is ReplyRow => row !== undefined);
    if (held.length === 0) {
      const [known] = await tx
        .select({ id: inboundComments.id })
        .from(inboundComments)
        .where(
          and(
            eq(inboundComments.provider, PROVIDER),
            eq(inboundComments.commentId, parent),
          ),
        );
      const ageMs = now.getTime() - inbound.createdAt.getTime();
      if (!known && ageMs < ORPHAN_COMMENT_TTL_SECONDS * 1000) {
        return defer("thread_unknown");
      }
      return ignore("no_hold");
    }
    const mine = inbound.authorId
      ? held.find((row) => row.authorId === inbound.authorId)
      : undefined;
    if (!mine) return ignore("not_author");
    if (!mine.warningCommentId) return defer("warning_pending");
    if (mine.expiresAt && mine.expiresAt.getTime() <= now.getTime()) {
      await expireReply(tx, mine, inbound.requestId);
      return ignore("expired");
    }
    const request = await requestFor(tx, inbound.requestId);
    const message = await releaseReply(tx, {
      request,
      body: mine.body,
      authorName: mine.authorName,
      displayAt: inbound.sourceCreatedAt,
    });
    const [updated] = await tx
      .update(replies)
      .set({
        status: "sent",
        messageId: message.id,
        confirmedBy: inbound.authorName ?? inbound.authorId,
        sentAt: now,
      })
      .where(eq(replies.id, mine.id))
      .returning();
    const sent = required(updated);
    await appendEvent(tx, {
      type: "reply.sent",
      channelKey: request.channelKey,
      requestId: request.id,
      payload: {
        replyId: sent.id,
        messageId: message.id,
        score: sent.wordingScore,
        flagged: false,
        confirmedBy: sent.confirmedBy,
      },
    });
    await markProcessed(tx, inbound.id, "confirm", message.id);
    return { outcome: "sent", reply: sent, message };
  });
}

export async function expireReply(
  tx: SupportTx,
  reply: ReplyRow,
  requestId: string,
): Promise<void> {
  await tx
    .update(replies)
    .set({ status: "expired" })
    .where(and(eq(replies.id, reply.id), eq(replies.status, "held")));
  const request = await requestFor(tx, requestId);
  await appendEvent(tx, {
    type: "reply.expired",
    channelKey: request.channelKey,
    requestId,
    payload: { replyId: reply.id },
  });
}

export async function recordReplyWarning(
  db: SupportExecutor,
  replyId: string,
  commentId: string,
): Promise<boolean> {
  const rows = await db
    .update(replies)
    .set({ warningCommentId: commentId })
    .where(and(eq(replies.id, replyId), isNull(replies.warningCommentId)))
    .returning({ id: replies.id });
  return rows.length > 0;
}

export async function lockReplyNeedingWarning(
  tx: SupportTx,
  inboundId: string,
  now: Date,
): Promise<ReplyRow | null> {
  const [row] = await tx
    .select()
    .from(replies)
    .where(
      and(
        eq(replies.inboundCommentId, inboundId),
        eq(replies.status, "held"),
        isNull(replies.warningCommentId),
        gt(replies.expiresAt, now),
      ),
    )
    .for("update");
  return row ?? null;
}

export async function lockReplyNeedingCancelNotice(
  tx: SupportTx,
  replyId: string,
): Promise<ReplyRow | null> {
  const [row] = await tx
    .select()
    .from(replies)
    .where(
      and(
        eq(replies.id, replyId),
        eq(replies.status, "cancelled"),
        isNull(replies.cancelNoticeCommentId),
      ),
    )
    .for("update");
  return row ?? null;
}

export async function recordCancelNotice(
  db: SupportExecutor,
  replyId: string,
  commentId: string,
): Promise<void> {
  await db
    .update(replies)
    .set({ cancelNoticeCommentId: commentId })
    .where(and(eq(replies.id, replyId), isNull(replies.cancelNoticeCommentId)));
}

export interface FlaggedReply {
  reply: ReplyRow;
  projectId: string;
  channelKey: string;
}

export async function listFlaggedReplies(
  db: SupportExecutor,
  options: { projectId?: string; limit?: number } = {},
): Promise<FlaggedReply[]> {
  const conditions = [eq(replies.flagged, true)];
  if (options.projectId)
    conditions.push(eq(requests.projectId, options.projectId));
  const rows = await db
    .select({
      reply: replies,
      projectId: requests.projectId,
      channelKey: requests.channelKey,
    })
    .from(replies)
    .innerJoin(requests, eq(requests.id, replies.requestId))
    .where(and(...conditions))
    .orderBy(desc(replies.createdAt), desc(replies.id))
    .limit(options.limit ?? 100);
  return rows;
}

export async function listHeldReplies(
  db: SupportExecutor,
  requestId: string,
  now: Date = new Date(),
): Promise<ReplyRow[]> {
  return db
    .select()
    .from(replies)
    .where(
      and(
        eq(replies.requestId, requestId),
        eq(replies.status, "held"),
        gt(replies.expiresAt, now),
      ),
    )
    .orderBy(asc(replies.createdAt));
}

export async function markMessageIntakeComplete(
  db: SupportExecutor,
  messageId: string,
  now: Date = new Date(),
): Promise<void> {
  await inTransaction(db, async (tx) => {
    const [message] = await tx
      .update(messages)
      .set({ intakeCompletedAt: now })
      .where(eq(messages.id, messageId))
      .returning({ requestId: messages.requestId });
    if (!message) return;
    const [ticketed] = await tx
      .select({ channelKey: requests.channelKey })
      .from(tickets)
      .innerJoin(requests, eq(requests.id, tickets.requestId))
      .where(eq(tickets.requestId, message.requestId));
    if (!ticketed) return;
    await appendEvent(tx, {
      type: "message.intake_completed",
      channelKey: ticketed.channelKey,
      requestId: message.requestId,
      payload: { messageId },
    });
  });
}

export async function markMessagesDeliveredViaTicket(
  db: SupportExecutor,
  input: {
    requestId: string;
    messageIds: string[];
    attachmentIds: string[];
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await markAttachmentsDelivered(db, input.attachmentIds, now);
  if (input.messageIds.length === 0) return;
  await db
    .insert(messageDeliveries)
    .values(
      input.messageIds.map((messageId) => ({
        messageId,
        requestId: input.requestId,
        via: "ticket",
        deliveredAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: messageDeliveries.messageId,
      set: { via: "ticket", deliveredAt: now },
      setWhere: isNull(messageDeliveries.deliveredAt),
    });
}

export interface PendingFollowUp {
  message: MessageRecord;
  attachmentNames: string[];
  attachmentIds: string[];
  ready: boolean;
}

export function isMessageReady(
  message: { intakeCompletedAt: Date | null; createdAt: Date },
  now: Date,
): boolean {
  return (
    message.intakeCompletedAt !== null ||
    now.getTime() - message.createdAt.getTime() >=
      MESSAGE_INTAKE_GRACE_SECONDS * 1000
  );
}

export async function listUndeliveredFollowUps(
  db: SupportExecutor,
  requestId: string,
  now: Date = new Date(),
): Promise<PendingFollowUp[]> {
  const rows = await db
    .select({ message: messages })
    .from(messages)
    .leftJoin(messageDeliveries, eq(messageDeliveries.messageId, messages.id))
    .where(
      and(
        eq(messages.requestId, requestId),
        eq(messages.author, "customer"),
        eq(messages.audience, "external"),
        eq(messages.originChannel, "widget"),
        isNull(messageDeliveries.deliveredAt),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));
  if (rows.length === 0) return [];
  const files = await db
    .select({
      id: attachments.id,
      messageId: attachments.messageId,
      filename: attachments.filename,
    })
    .from(attachments)
    .where(
      inArray(
        attachments.messageId,
        rows.map((row) => row.message.id),
      ),
    )
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  return rows.map(({ message }) => {
    const own = files.filter((file) => file.messageId === message.id);
    return {
      message,
      attachmentNames: own.map((file) => file.filename),
      attachmentIds: own.map((file) => file.id),
      ready: isMessageReady(message, now),
    };
  });
}

export interface LateAttachments {
  messageId: string;
  attachmentIds: string[];
  attachmentNames: string[];
}

export async function listLateAttachments(
  db: SupportExecutor,
  requestId: string,
  now: Date = new Date(),
): Promise<LateAttachments[]> {
  const rows = await db
    .select({
      message: messages,
      id: attachments.id,
      filename: attachments.filename,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(
      messageDeliveries,
      and(
        eq(messageDeliveries.messageId, messages.id),
        isNotNull(messageDeliveries.deliveredAt),
      ),
    )
    .where(
      and(
        eq(messages.requestId, requestId),
        isNull(attachments.linearDeliveredAt),
      ),
    )
    .orderBy(
      asc(messages.createdAt),
      asc(attachments.createdAt),
      asc(attachments.id),
    );
  const grouped = new Map<string, LateAttachments>();
  for (const row of rows) {
    if (!isMessageReady(row.message, now)) continue;
    const entry = grouped.get(row.message.id) ?? {
      messageId: row.message.id,
      attachmentIds: [],
      attachmentNames: [],
    };
    entry.attachmentIds.push(row.id);
    entry.attachmentNames.push(row.filename);
    grouped.set(row.message.id, entry);
  }
  return [...grouped.values()];
}

export async function markAttachmentsDelivered(
  db: SupportExecutor,
  attachmentIds: string[],
  now: Date = new Date(),
): Promise<void> {
  if (attachmentIds.length === 0) return;
  await db
    .update(attachments)
    .set({ linearDeliveredAt: now })
    .where(inArray(attachments.id, attachmentIds));
}

export async function recordFollowUpDelivered(
  db: SupportExecutor,
  input: {
    messageId: string;
    requestId: string;
    linearCommentId: string;
    attachmentIds?: string[];
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .insert(messageDeliveries)
    .values({
      messageId: input.messageId,
      requestId: input.requestId,
      via: "comment",
      linearCommentId: input.linearCommentId,
      deliveredAt: now,
    })
    .onConflictDoUpdate({
      target: messageDeliveries.messageId,
      set: {
        via: "comment",
        linearCommentId: input.linearCommentId,
        deliveredAt: now,
      },
    });
  await markAttachmentsDelivered(db, input.attachmentIds ?? [], now);
}

export function followUpLockKey(requestId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${requestId}, 18))`;
}
