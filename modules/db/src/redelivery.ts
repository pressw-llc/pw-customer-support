import {
  type EventEnvelope,
  eventEnvelopeSchema,
  MESSAGE_INTAKE_GRACE_SECONDS,
  ORPHAN_COMMENT_TTL_SECONDS,
  TICKET_REDELIVERY_BASE_SECONDS,
  TICKET_REDELIVERY_MAX_SECONDS,
  WEBHOOK_RETENTION_SECONDS,
} from "@pw-support/contracts";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { inTransaction, type SupportExecutor, type SupportTx } from "./client";
import {
  appendCommentReceived,
  expireReply,
  findTicketByLinearIssue,
  type RequestRecord,
} from "./replies";
import { inboundComments, replies, tickets, webhookDeliveries } from "./schema";

const FOLLOW_UP_LOCK_ID = 7_340_003;
const INBOUND_LOCK_ID = 7_340_004;
const MAX_BACKOFF_EXPONENT = 20;

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
          m.id AS message_id, COALESCE(d.delivery_attempts, 0) AS attempts
        FROM support.events e
        JOIN support.messages m ON m.id = (e.payload->>'messageId')::uuid
        LEFT JOIN support.message_deliveries d ON d.message_id = m.id
        WHERE e.type = 'message.created'
          AND e.request_id IS NOT NULL
          ${requestFilter}
          AND m.author = 'customer' AND m.audience = 'external' AND m.origin_channel = 'widget'
          AND (d.delivered_at IS NULL OR EXISTS (
            SELECT 1 FROM support.attachments a
            WHERE a.message_id = m.id AND a.linear_delivered_at IS NULL
          ))
          AND EXISTS (SELECT 1 FROM support.tickets t WHERE t.request_id = e.request_id)
          AND (m.intake_completed_at IS NOT NULL
            OR m.created_at <= ${nowTs}::timestamptz - make_interval(secs => ${MESSAGE_INTAKE_GRACE_SECONDS}))
          AND COALESCE(d.last_enqueued_at, m.created_at)
            <= ${nowTs}::timestamptz - make_interval(
              secs => LEAST(${max}::double precision, ${base}::double precision * power(2, LEAST(COALESCE(d.delivery_attempts, 0), ${MAX_BACKOFF_EXPONENT})))
            )
        ORDER BY COALESCE(d.delivery_attempts, 0), e.seq
        LIMIT ${limit}
      ), marked AS (
        INSERT INTO support.message_deliveries (message_id, request_id, delivery_attempts, last_enqueued_at)
        SELECT message_id, request_id, 1, ${nowTs}::timestamptz FROM due
        ON CONFLICT (message_id) DO UPDATE
          SET delivery_attempts = support.message_deliveries.delivery_attempts + 1,
              last_enqueued_at = EXCLUDED.last_enqueued_at
      )
      SELECT id, seq, type, channel_key, request_id, payload, created_at
      FROM due ORDER BY attempts, seq
    `);
    return rows.map(eventFromRow);
  });
}

export interface InboundRedeliveryOptions {
  now?: Date;
  limit?: number;
  requestId?: string;
  maxAgeSeconds?: number;
  baseSeconds?: number;
  maxSeconds?: number;
}

export async function claimStaleInboundEvents(
  db: SupportExecutor,
  options: InboundRedeliveryOptions = {},
): Promise<EventEnvelope[]> {
  const nowTs = (options.now ?? new Date()).toISOString();
  const base = options.baseSeconds ?? TICKET_REDELIVERY_BASE_SECONDS;
  const max = options.maxSeconds ?? TICKET_REDELIVERY_MAX_SECONDS;
  const maxAge = options.maxAgeSeconds ?? 24 * 60 * 60;
  const limit = options.limit ?? 20;
  const requestFilter = options.requestId
    ? sql`AND i.request_id = ${options.requestId}`
    : sql``;
  return inTransaction(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INBOUND_LOCK_ID})`);
    const rows = await tx.execute<Record<string, unknown>>(sql`
      WITH candidates AS (
        SELECT i.id FROM support.inbound_comments i
        WHERE i.status = 'pending' AND i.request_id IS NOT NULL
        UNION
        SELECT r.inbound_comment_id FROM support.replies r
        WHERE r.status = 'held' AND r.warning_comment_id IS NULL
          AND r.expires_at > ${nowTs}::timestamptz
      ), due AS (
        SELECT e.id, e.seq, e.type, e.channel_key, e.request_id, e.payload, e.created_at,
          i.id AS inbound_id, i.delivery_attempts AS attempts
        FROM candidates c
        JOIN support.inbound_comments i ON i.id = c.id
        JOIN support.events e
          ON e.type = 'comment.received' AND (e.payload->>'inboundId')::uuid = i.id
        WHERE i.created_at >= ${nowTs}::timestamptz - make_interval(secs => ${maxAge})
          ${requestFilter}
          AND COALESCE(i.last_enqueued_at, i.created_at)
            <= ${nowTs}::timestamptz - make_interval(
              secs => LEAST(${max}::double precision, ${base}::double precision * power(2, LEAST(i.delivery_attempts, ${MAX_BACKOFF_EXPONENT})))
            )
        ORDER BY i.delivery_attempts, e.seq
        LIMIT ${limit}
      ), marked AS (
        UPDATE support.inbound_comments u
        SET delivery_attempts = u.delivery_attempts + 1,
            last_enqueued_at = ${nowTs}::timestamptz
        FROM due WHERE u.id = due.inbound_id
      )
      SELECT id, seq, type, channel_key, request_id, payload, created_at
      FROM due ORDER BY attempts, seq
    `);
    return rows.map(eventFromRow);
  });
}

export async function attachOrphanComments(
  tx: SupportTx,
  issueId: string,
  request: RequestRecord,
): Promise<number> {
  const orphans = await tx
    .select()
    .from(inboundComments)
    .where(
      and(
        eq(inboundComments.issueId, issueId),
        eq(inboundComments.status, "pending"),
        isNull(inboundComments.requestId),
      ),
    )
    .orderBy(asc(inboundComments.createdAt), asc(inboundComments.id))
    .for("update");
  for (const orphan of orphans) {
    await tx
      .update(inboundComments)
      .set({ requestId: request.id })
      .where(eq(inboundComments.id, orphan.id));
    await appendCommentReceived(tx, request, {
      ...orphan,
      requestId: request.id,
    });
  }
  return orphans.length;
}

export interface OrphanResolution {
  attached: number;
  ignored: number;
}

export async function resolveOrphanComments(
  db: SupportExecutor,
  options: { now?: Date } = {},
): Promise<OrphanResolution> {
  const now = options.now ?? new Date();
  const issues = await db
    .selectDistinct({ issueId: inboundComments.issueId })
    .from(inboundComments)
    .innerJoin(tickets, eq(tickets.linearIssueId, inboundComments.issueId))
    .where(
      and(
        eq(inboundComments.status, "pending"),
        isNull(inboundComments.requestId),
      ),
    );
  let attached = 0;
  for (const { issueId } of issues) {
    attached += await inTransaction(db, async (tx) => {
      const found = await findTicketByLinearIssue(tx, issueId);
      return found ? attachOrphanComments(tx, issueId, found.request) : 0;
    });
  }
  const cutoff = new Date(now.getTime() - ORPHAN_COMMENT_TTL_SECONDS * 1000);
  const expired = await db
    .update(inboundComments)
    .set({
      status: "processed",
      disposition: "ignored:unknown_issue",
      body: "",
      processedAt: now,
    })
    .where(
      and(
        eq(inboundComments.status, "pending"),
        isNull(inboundComments.requestId),
        lte(inboundComments.createdAt, cutoff),
      ),
    )
    .returning({ id: inboundComments.id });
  return { attached, ignored: expired.length };
}

export async function expireHeldReplies(
  db: SupportExecutor,
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  return inTransaction(db, async (tx) => {
    const due = await tx
      .select()
      .from(replies)
      .where(and(eq(replies.status, "held"), lte(replies.expiresAt, now)))
      .orderBy(asc(replies.expiresAt))
      .limit(options.limit ?? 100)
      .for("update", { skipLocked: true });
    for (const reply of due) await expireReply(tx, reply, reply.requestId);
    return due.length;
  });
}

export async function purgeStaleRecords(
  db: SupportExecutor,
  options: { now?: Date } = {},
): Promise<{ deliveries: number; comments: number }> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - WEBHOOK_RETENTION_SECONDS * 1000);
  const deliveries = await db
    .delete(webhookDeliveries)
    .where(lte(webhookDeliveries.receivedAt, cutoff))
    .returning({ id: webhookDeliveries.deliveryId });
  const comments = await db
    .delete(inboundComments)
    .where(
      and(
        isNull(inboundComments.requestId),
        eq(inboundComments.status, "processed"),
        lte(inboundComments.processedAt, cutoff),
      ),
    )
    .returning({ id: inboundComments.id });
  return { deliveries: deliveries.length, comments: comments.length };
}
