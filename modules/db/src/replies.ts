import {
  type EventEnvelope,
  eventEnvelopeSchema,
  MESSAGE_INTAKE_GRACE_SECONDS,
  REPLY_HOLD_TTL_SECONDS,
  type ReplyBand,
  type ReplyHoldReason,
  TICKET_REDELIVERY_BASE_SECONDS,
  TICKET_REDELIVERY_MAX_SECONDS,
  WORDING_HOLD_BELOW,
} from "@pw-support/contracts";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  inTransaction,
  type SupportExecutor,
  type SupportTx,
} from "./client";
import { appendEvent } from "./events";
import {
  attachments,
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
const FOLLOW_UP_LOCK_ID = 7_340_003;

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
}

export type InboundCommentResult =
  | { status: "stored"; inbound: InboundCommentRow }
  | { status: "duplicate_delivery" }
  | { status: "duplicate_comment" }
  | { status: "unknown_issue" };

export async function persistInboundComment(
  db: SupportExecutor,
  input: InboundCommentInput,
): Promise<InboundCommentResult> {
  return inTransaction(db, async (tx) => {
    const delivery = await tx
      .insert(webhookDeliveries)
      .values({ deliveryId: input.deliveryId, provider: PROVIDER })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.deliveryId });
    if (delivery.length === 0) return { status: "duplicate_delivery" };
    const found = await findTicketByLinearIssue(tx, input.issueId);
    if (!found) return { status: "unknown_issue" };
    const [inbound] = await tx
      .insert(inboundComments)
      .values({
        provider: PROVIDER,
        commentId: input.commentId,
        issueId: input.issueId,
        parentCommentId: input.parentCommentId,
        authorId: input.authorId,
        authorName: input.authorName,
        body: input.body,
        requestId: found.request.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!inbound) return { status: "duplicate_comment" };
    await appendEvent(tx, {
      type: "comment.received",
      channelKey: found.request.channelKey,
      requestId: found.request.id,
      payload: {
        inboundId: inbound.id,
        commentId: input.commentId,
        issueId: input.issueId,
      },
    });
    return { status: "stored", inbound };
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
    .where(eq(replies.warningCommentId, commentId))
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

export async function storeInternalComment(
  db: SupportExecutor,
  inboundId: string,
): Promise<MessageRecord | null> {
  return inTransaction(db, async (tx) => {
    const inbound = await lockPending(tx, inboundId);
    if (!inbound) return null;
    const [message] = await tx
      .insert(messages)
      .values({
        requestId: inbound.requestId,
        body: inbound.body,
        originChannel: "linear",
        author: "staff",
        authorName: inbound.authorName,
        audience: "internal",
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
    if (!inbound) return null;
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
        payload: { replyId: sent.id, messageId: message.id, score: input.score },
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
  | { outcome: "ignored"; reason: string };

export async function confirmHeldReply(
  db: SupportExecutor,
  input: { inboundId: string; now?: Date },
): Promise<ConfirmOutcome | null> {
  return inTransaction(db, async (tx) => {
    const inbound = await lockPending(tx, input.inboundId);
    if (!inbound) return null;
    const now = input.now ?? new Date();
    const ignore = async (reason: string): Promise<ConfirmOutcome> => {
      await markProcessed(tx, inbound.id, `confirm_ignored:${reason}`);
      return { outcome: "ignored", reason };
    };
    if (!inbound.parentCommentId) return ignore("no_thread");
    const held = await tx
      .select()
      .from(replies)
      .where(
        and(
          eq(replies.requestId, inbound.requestId),
          eq(replies.threadRootId, inbound.parentCommentId),
          eq(replies.status, "held"),
        ),
      )
      .orderBy(desc(replies.heldAt), desc(replies.id))
      .for("update");
    if (held.length === 0) return ignore("no_hold");
    const mine = inbound.authorId
      ? held.find((reply) => reply.authorId === inbound.authorId)
      : undefined;
    if (!mine) return ignore("not_author");
    if (mine.expiresAt && mine.expiresAt.getTime() <= now.getTime()) {
      await tx
        .update(replies)
        .set({ status: "expired" })
        .where(eq(replies.id, mine.id));
      return ignore("expired");
    }
    const request = await requestFor(tx, inbound.requestId);
    const message = await releaseReply(tx, {
      request,
      body: mine.body,
      authorName: mine.authorName,
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
  if (options.projectId) conditions.push(eq(requests.projectId, options.projectId));
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
): Promise<ReplyRow[]> {
  return db
    .select()
    .from(replies)
    .where(and(eq(replies.requestId, requestId), eq(replies.status, "held")))
    .orderBy(asc(replies.createdAt));
}

export async function markMessageIntakeComplete(
  db: SupportExecutor,
  messageId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(messages)
    .set({ intakeCompletedAt: now })
    .where(eq(messages.id, messageId));
}

export async function markMessagesDeliveredViaTicket(
  db: SupportExecutor,
  requestId: string,
  messageIds: string[],
  now: Date = new Date(),
): Promise<void> {
  if (messageIds.length === 0) return;
  await db
    .insert(messageDeliveries)
    .values(
      messageIds.map((messageId) => ({
        messageId,
        requestId,
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
  ready: boolean;
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
    .select({ messageId: attachments.messageId, filename: attachments.filename })
    .from(attachments)
    .where(
      inArray(
        attachments.messageId,
        rows.map((row) => row.message.id),
      ),
    )
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  const graceMs = MESSAGE_INTAKE_GRACE_SECONDS * 1000;
  return rows.map(({ message }) => ({
    message,
    attachmentNames: files
      .filter((file) => file.messageId === message.id)
      .map((file) => file.filename),
    ready:
      message.intakeCompletedAt !== null ||
      now.getTime() - message.createdAt.getTime() >= graceMs,
  }));
}

export async function recordFollowUpDelivered(
  db: SupportExecutor,
  input: {
    messageId: string;
    requestId: string;
    linearCommentId: string;
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
}

export function followUpLockKey(requestId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${requestId}, 18))`;
}

function eventFromRow(row: Record<string, unknown>): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: row.id,
    seq: row.seq,
    type: row.type,
    channelKey: row.channel_key,
    requestId: row.request_id,
    payload: row.payload,
    createdAt: row.created_at,
  });
}

export interface FollowUpRedeliveryOptions {
  now?: Date;
  limit?: number;
  requestId?: string;
  baseSeconds?: number;
  maxSeconds?: number;
}

export async function claimFollowUpRedeliveries(
  db: SupportExecutor,
  options: FollowUpRedeliveryOptions = {},
): Promise<EventEnvelope[]> {
  const nowTs = (options.now ?? new Date()).toISOString();
  const base = options.baseSeconds ?? TICKET_REDELIVERY_BASE_SECONDS;
  const max = options.maxSeconds ?? TICKET_REDELIVERY_MAX_SECONDS;
  const limit = options.limit ?? 50;
  const requestFilter = options.requestId
    ? sql`AND e.request_id = ${options.requestId}`
    : sql``;
  return inTransaction(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${FOLLOW_UP_LOCK_ID})`);
    const rows = await tx.execute<Record<string, unknown>>(sql`
      WITH due AS (
        SELECT e.id, e.seq, e.type, e.channel_key, e.request_id, e.payload, e.created_at,
          m.id AS message_id
        FROM support.events e
        JOIN support.messages m ON m.id::text = e.payload->>'messageId'
        LEFT JOIN support.message_deliveries d ON d.message_id = m.id
        WHERE e.type = 'message.created'
          AND e.request_id IS NOT NULL
          ${requestFilter}
          AND m.author = 'customer' AND m.audience = 'external' AND m.origin_channel = 'widget'
          AND d.delivered_at IS NULL
          AND EXISTS (SELECT 1 FROM support.tickets t WHERE t.request_id = e.request_id)
          AND (m.intake_completed_at IS NOT NULL
            OR m.created_at <= ${nowTs}::timestamptz - make_interval(secs => ${MESSAGE_INTAKE_GRACE_SECONDS}))
          AND COALESCE(d.last_enqueued_at, m.created_at)
            <= ${nowTs}::timestamptz - make_interval(
              secs => LEAST(${max}::double precision, ${base}::double precision * power(2, LEAST(COALESCE(d.delivery_attempts, 0), 20)))
            )
        ORDER BY e.seq
        LIMIT ${limit}
      ), marked AS (
        INSERT INTO support.message_deliveries (message_id, request_id, delivery_attempts, last_enqueued_at)
        SELECT message_id, request_id, 1, ${nowTs}::timestamptz FROM due
        ON CONFLICT (message_id) DO UPDATE
          SET delivery_attempts = support.message_deliveries.delivery_attempts + 1,
              last_enqueued_at = EXCLUDED.last_enqueued_at
      )
      SELECT id, seq, type, channel_key, request_id, payload, created_at
      FROM due ORDER BY seq
    `);
    return rows.map(eventFromRow);
  });
}

export interface InboundRedeliveryOptions {
  now?: Date;
  limit?: number;
  staleSeconds?: number;
  maxAgeSeconds?: number;
}

export async function listStaleInboundEvents(
  db: SupportExecutor,
  options: InboundRedeliveryOptions = {},
): Promise<EventEnvelope[]> {
  const nowTs = (options.now ?? new Date()).toISOString();
  const stale = options.staleSeconds ?? 60;
  const maxAge = options.maxAgeSeconds ?? 24 * 60 * 60;
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT e.id, e.seq, e.type, e.channel_key, e.request_id, e.payload, e.created_at
    FROM support.events e
    JOIN support.inbound_comments i ON i.id::text = e.payload->>'inboundId'
    LEFT JOIN support.replies r ON r.inbound_comment_id = i.id
    WHERE e.type = 'comment.received'
      AND i.created_at <= ${nowTs}::timestamptz - make_interval(secs => ${stale})
      AND i.created_at >= ${nowTs}::timestamptz - make_interval(secs => ${maxAge})
      AND (i.status = 'pending'
        OR (r.status = 'held' AND r.warning_comment_id IS NULL))
    ORDER BY e.seq
    LIMIT ${options.limit ?? 20}
  `);
  return rows.map(eventFromRow);
}
