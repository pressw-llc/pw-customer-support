import {
  bandForScore,
  type ChannelAdapter,
  type EventEnvelope,
  type HumanTriageReason,
  humanTriageReasonSchema,
  MAX_MESSAGE_CHARS,
  REPLY_HOLD_TTL_SECONDS,
  type ReplyBand,
  type ReplyHoldReason,
  triageOutcomeSchema,
  triageResultSchema,
  WORDING_MAX_SCORE,
} from "@pw-support/contracts";
import {
  appendEvent,
  applyFetchedComment,
  attachOrphanComments,
  claimFollowUpRedeliveries,
  claimStaleInboundEvents,
  claimTicketRedeliveries,
  commentNeedsRefresh,
  confirmHeldReply,
  displayBody,
  expireHeldReplies,
  type FetchedComment,
  findTicketByRequest,
  followUpLockKey,
  getInboundComment,
  getTriageJobForRequest,
  type InboundCommentRow,
  ignoreInboundComment,
  insertTicket,
  inTransaction,
  isMessageReady,
  isRecordedOwnComment,
  listHeldNeedingRefresh,
  listJudgments,
  listLateAttachments,
  listUndeliveredFollowUps,
  loadTriageContext,
  lockReplyNeedingCancelNotice,
  lockReplyNeedingWarning,
  markAttachmentsDelivered,
  markMessagesDeliveredViaTicket,
  purgeStaleRecords,
  recordCancelNotice,
  recordFollowUpDelivered,
  recordReplyWarning,
  requestHasEvent,
  resolveExternalReply,
  resolveOrphanComments,
  type SupportDb,
  storeInternalComment,
  type TicketRow,
} from "@pw-support/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  buildCancelNotice,
  buildHoldWarning,
  cancelMarker,
  classifyStaffComment,
  isConfirmComment,
  isSystemComment,
  replyMarker,
} from "../reply/marker";
import type { WordingScorer } from "../reply/wording";
import type { LinearClient } from "./client";
import {
  attachmentsMarker,
  buildFollowUpParts,
  buildLateAttachmentsComment,
  buildTicket,
  QUOTE_MAX_CHARS,
  requestMarker,
} from "./ticket";
import { cleanAuthorName, cleanBody } from "./webhook";

export const LINEAR_ADAPTER_NAME = "linear";

const PURGE_INTERVAL_MS = 10 * 60 * 1000;

const storedResultSchema = z.object({
  result: triageResultSchema,
  humanTriageReason: humanTriageReasonSchema.optional(),
});

export type TicketOutcome =
  | { status: "created"; ticket: TicketRow }
  | { status: "exists"; ticket: TicketRow }
  | { status: "blocked"; reason: "no_linear_team" };

export interface LinearAdapterDeps {
  db: SupportDb;
  linear: LinearClient;
  wording?: WordingScorer | null;
  holdTtlSeconds?: number;
  now?: () => Date;
}

export interface LinearAdapter extends ChannelAdapter {
  createTicketForRequest(requestId: string): Promise<TicketOutcome>;
  syncFollowUps(requestId: string): Promise<number>;
  processInboundComment(inboundId: string): Promise<void>;
  redeliver(): Promise<EventEnvelope[]>;
}

interface WordingDecision {
  score: number;
  band: ReplyBand;
  holdReason?: ReplyHoldReason;
  raw: Record<string, unknown>;
}

const inboundPayloadSchema = z.object({ inboundId: z.string().uuid() });
const cancelledPayloadSchema = z.object({ replyId: z.string().uuid() });

export function createLinearAdapter(deps: LinearAdapterDeps): LinearAdapter {
  const { db, linear } = deps;
  const clock = deps.now ?? (() => new Date());
  let lastPurgeAt = Number.NEGATIVE_INFINITY;

  async function decideWording(text: string): Promise<WordingDecision> {
    if (text.length > MAX_MESSAGE_CHARS) {
      return {
        score: 0,
        band: "hold",
        holdReason: "too_long",
        raw: { error: "too_long", length: text.length },
      };
    }
    const unavailable = (error: string): WordingDecision => ({
      score: 0,
      band: "hold",
      holdReason: "wording_unavailable",
      raw: { error },
    });
    if (!deps.wording) return unavailable("scorer_not_configured");
    try {
      const result = await deps.wording.score(text);
      if (!Number.isFinite(result.score)) return unavailable("invalid_score");
      const score = Math.min(WORDING_MAX_SCORE, Math.max(0, result.score));
      const band = bandForScore(score);
      return {
        score,
        band,
        holdReason: band === "hold" ? "wording_low" : undefined,
        raw: result.raw,
      };
    } catch (error) {
      return unavailable(
        (error instanceof Error ? error.message : String(error)).slice(0, 200),
      );
    }
  }

  async function isOwnComment(inbound: InboundCommentRow): Promise<boolean> {
    return (
      isSystemComment(inbound.body) ||
      (await isRecordedOwnComment(db, inbound.commentId))
    );
  }

  async function ensureHoldWarning(inbound: InboundCommentRow): Promise<void> {
    await inTransaction(db, async (tx) => {
      const reply = await lockReplyNeedingWarning(tx, inbound.id, clock());
      if (!reply) return;
      const existing = await linear.findCommentByMarker(
        inbound.issueId,
        replyMarker(reply.id),
      );
      const warning =
        existing ??
        (await linear.createComment(
          inbound.issueId,
          buildHoldWarning({
            reason: (reply.holdReason ?? "wording_low") as ReplyHoldReason,
            score: reply.wordingScore,
            maxChars: MAX_MESSAGE_CHARS,
            replyId: reply.id,
          }),
          reply.threadRootId,
        ));
      await recordReplyWarning(tx, reply.id, warning.id);
    });
  }

  async function fetchCurrent(
    commentId: string,
  ): Promise<FetchedComment | null> {
    const found = await linear.getComment(commentId);
    if (!found || found.archived) return null;
    const created = new Date(found.createdAt);
    const updated = new Date(found.updatedAt);
    return {
      issueId: found.issueId ?? "",
      body: cleanBody(found.body),
      parentCommentId: found.parentId,
      authorId: found.automated ? null : found.userId,
      authorName: cleanAuthorName(found.userName),
      createdAt: Number.isNaN(created.getTime()) ? clock() : created,
      updatedAt: Number.isNaN(updated.getTime()) ? clock() : updated,
    };
  }

  async function refreshFromLinear(inbound: InboundCommentRow) {
    await applyFetchedComment(
      db,
      inbound.id,
      await fetchCurrent(inbound.commentId),
    );
  }

  async function refreshHeldReplies(inbound: InboundCommentRow) {
    if (!inbound.requestId || !inbound.parentCommentId) return;
    const stale = await listHeldNeedingRefresh(
      db,
      inbound.requestId,
      inbound.parentCommentId,
    );
    for (const held of stale) await refreshFromLinear(held);
  }

  async function postCancelNotice(replyId: string): Promise<void> {
    await inTransaction(db, async (tx) => {
      const reply = await lockReplyNeedingCancelNotice(tx, replyId);
      if (!reply) return;
      const inbound = await getInboundComment(tx, reply.inboundCommentId);
      if (!inbound) return;
      const existing = await linear.findCommentByMarker(
        inbound.issueId,
        cancelMarker(reply.id),
      );
      const notice =
        existing ??
        (await linear.createComment(
          inbound.issueId,
          buildCancelNotice(reply.id),
          reply.cancelReason === "removed" &&
            reply.threadRootId === inbound.commentId
            ? undefined
            : reply.threadRootId,
        ));
      await recordCancelNotice(tx, reply.id, notice.id);
    });
  }

  async function processInboundComment(inboundId: string): Promise<void> {
    let inbound = await getInboundComment(db, inboundId);
    if (!inbound) return;
    if (inbound.status === "processed") {
      await ensureHoldWarning(inbound);
      return;
    }
    if (!inbound.requestId) return;
    if (await commentNeedsRefresh(db, inbound)) {
      await refreshFromLinear(inbound);
      inbound = await getInboundComment(db, inboundId);
      if (!inbound || inbound.status === "processed") return;
    }
    if (await isOwnComment(inbound)) {
      await ignoreInboundComment(db, inbound.id, "own_comment");
      return;
    }
    if (inbound.authorId === null) {
      await storeInternalComment(db, inbound.id);
      return;
    }
    if (inbound.parentCommentId && isConfirmComment(inbound.body)) {
      await refreshHeldReplies(inbound);
      await confirmHeldReply(db, {
        inboundId: inbound.id,
        sourceBody: inbound.body,
        now: clock(),
      });
      return;
    }
    const classified = classifyStaffComment(inbound.body);
    if (classified.kind === "internal") {
      await storeInternalComment(db, inbound.id);
      return;
    }
    const decision = await decideWording(classified.text);
    const resolved = await resolveExternalReply(db, {
      inboundId: inbound.id,
      sourceBody: inbound.body,
      text: classified.text,
      score: decision.score,
      band: decision.band,
      holdReason: decision.holdReason,
      raw: decision.raw,
      now: clock(),
      holdTtlSeconds: deps.holdTtlSeconds ?? REPLY_HOLD_TTL_SECONDS,
    });
    if (resolved) await ensureHoldWarning(inbound);
  }

  async function syncFollowUps(requestId: string): Promise<number> {
    return inTransaction(db, async (tx) => {
      await tx.execute(followUpLockKey(requestId));
      const ticket = await findTicketByRequest(tx, requestId);
      if (!ticket) return 0;
      const pending = await listUndeliveredFollowUps(tx, requestId, clock());
      const firstId = (await loadTriageContext(tx, requestId))?.messages[0]?.id;
      let delivered = 0;
      for (const item of pending) {
        if (!item.ready) break;
        const parts = buildFollowUpParts({
          messageId: item.message.id,
          originChannel: item.message.originChannel,
          text: displayBody(item.message),
          attachmentNames: item.attachmentNames,
          headChars: item.message.id === firstId ? QUOTE_MAX_CHARS : 0,
        });
        let firstCommentId: string | undefined;
        for (const part of parts) {
          const found = await linear.findCommentByMarker(
            ticket.linearIssueId,
            part.marker,
          );
          const comment =
            found ??
            (await linear.createComment(ticket.linearIssueId, part.body));
          firstCommentId ??= comment.id;
        }
        await recordFollowUpDelivered(tx, {
          messageId: item.message.id,
          requestId,
          linearCommentId: firstCommentId as string,
          attachmentIds: item.attachmentIds,
          now: clock(),
        });
        delivered++;
      }
      for (const late of await listLateAttachments(tx, requestId, clock())) {
        const marker = attachmentsMarker(late.attachmentIds);
        const found = await linear.findCommentByMarker(
          ticket.linearIssueId,
          marker,
        );
        if (!found) {
          await linear.createComment(
            ticket.linearIssueId,
            buildLateAttachmentsComment({
              originChannel: "widget",
              attachmentNames: late.attachmentNames,
              marker,
            }),
          );
        }
        await markAttachmentsDelivered(tx, late.attachmentIds, clock());
        delivered++;
      }
      return delivered;
    });
  }

  async function createTicketForRequest(
    requestId: string,
  ): Promise<TicketOutcome> {
    return inTransaction(db, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${requestId}, 17))`,
      );
      const existing = await findTicketByRequest(tx, requestId);
      if (existing) return { status: "exists", ticket: existing };
      const job = await getTriageJobForRequest(tx, requestId);
      if (job?.status !== "completed" || !job.result) {
        throw new Error(`triage job for request ${requestId} is not complete`);
      }
      const stored = storedResultSchema.parse(job.result);
      const context = await loadTriageContext(tx, requestId);
      if (!context) throw new Error(`request ${requestId} not found`);
      const teamId = context.project.linearTeamId;
      if (!teamId) {
        if (!(await requestHasEvent(tx, requestId, "ticket.blocked"))) {
          await appendEvent(tx, {
            type: "ticket.blocked",
            channelKey: context.request.channelKey,
            requestId,
            payload: {
              reason: "no_linear_team",
              projectId: context.project.id,
            },
          });
        }
        return { status: "blocked", reason: "no_linear_team" };
      }
      const outcome = triageOutcomeSchema.parse(job.outcome);
      const withheld = new Set(
        (await listJudgments(tx, requestId))
          .filter((row) => row.raw.skipped === true)
          .map((row) => row.subject),
      );
      const draft = buildTicket({
        requestId,
        result: stored.result,
        outcome,
        humanTriageReason: stored.humanTriageReason as
          | HumanTriageReason
          | undefined,
        messages: context.messages.map((message, index) => ({
          id: message.id,
          text: message.body,
          ready: index === 0 || isMessageReady(message, clock()),
        })),
        attachments: context.attachments.map((file) => ({
          id: file.id,
          messageId: file.messageId,
          filename: file.filename,
          notAnalyzed: withheld.has(`image:${file.id}`),
        })),
      });
      const labelIds: string[] = [];
      for (const name of draft.labelNames) {
        labelIds.push(await linear.findOrCreateLabel(teamId, name));
      }
      const adopted = await linear.findIssueByMarker(
        teamId,
        requestMarker(requestId),
      );
      const issue =
        adopted ??
        (await linear.createIssue({
          teamId,
          title: draft.title,
          description: draft.description,
          priority: draft.priority,
          labelIds,
        }));
      const ticket = await insertTicket(tx, {
        requestId,
        linearIssueId: issue.id,
        identifier: issue.identifier,
        url: issue.url,
      });
      if (!ticket) {
        const winner = await findTicketByRequest(tx, requestId);
        if (!winner) throw new Error("ticket insert conflicted without a row");
        return { status: "exists", ticket: winner };
      }
      await attachOrphanComments(tx, issue.id, context.request);
      if (!adopted) {
        await markMessagesDeliveredViaTicket(tx, {
          requestId,
          messageIds: draft.deliveredMessageIds,
          attachmentIds: draft.deliveredAttachmentIds,
          now: clock(),
        });
      }
      await appendEvent(tx, {
        type: "ticket.created",
        channelKey: context.request.channelKey,
        requestId,
        payload: {
          ticketId: ticket.id,
          identifier: issue.identifier,
          url: issue.url,
          linearIssueId: issue.id,
          outcome,
        },
      });
      return { status: "created", ticket };
    });
  }

  return {
    name: LINEAR_ADAPTER_NAME,
    subscribes: [
      "triage.result.accepted",
      "ticket.created",
      "message.created",
      "message.intake_completed",
      "comment.received",
      "reply.cancelled",
    ],
    async handle(event: EventEnvelope) {
      if (event.type === "comment.received") {
        const payload = inboundPayloadSchema.safeParse(event.payload);
        if (payload.success)
          await processInboundComment(payload.data.inboundId);
        return;
      }
      if (event.type === "reply.cancelled") {
        const payload = cancelledPayloadSchema.safeParse(event.payload);
        if (payload.success) await postCancelNotice(payload.data.replyId);
        return;
      }
      if (!event.requestId) return;
      if (event.type === "triage.result.accepted") {
        await createTicketForRequest(event.requestId);
        return;
      }
      await syncFollowUps(event.requestId);
    },
    async redeliver() {
      const now = clock();
      await resolveOrphanComments(db, { now });
      await expireHeldReplies(db, { now });
      if (now.getTime() - lastPurgeAt >= PURGE_INTERVAL_MS) {
        lastPurgeAt = now.getTime();
        await purgeStaleRecords(db, { now });
      }
      return [
        ...(await claimTicketRedeliveries(db, { now })),
        ...(await claimFollowUpRedeliveries(db, { now })),
        ...(await claimStaleInboundEvents(db, { now })),
      ];
    },
    createTicketForRequest,
    syncFollowUps,
    processInboundComment,
  };
}
