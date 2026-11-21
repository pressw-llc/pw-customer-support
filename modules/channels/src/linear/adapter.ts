import {
  bandForScore,
  type ChannelAdapter,
  type EventEnvelope,
  type HumanTriageReason,
  humanTriageReasonSchema,
  MAX_MESSAGE_CHARS,
  type ReplyBand,
  type ReplyHoldReason,
  REPLY_HOLD_TTL_SECONDS,
  triageOutcomeSchema,
  triageResultSchema,
  WORDING_MAX_SCORE,
} from "@pw-support/contracts";
import {
  appendEvent,
  claimFollowUpRedeliveries,
  claimTicketRedeliveries,
  confirmHeldReply,
  displayBody,
  findTicketByRequest,
  followUpLockKey,
  getInboundComment,
  getReplyByInbound,
  getTriageJobForRequest,
  type InboundCommentRow,
  ignoreInboundComment,
  insertTicket,
  inTransaction,
  isRecordedOwnComment,
  listJudgments,
  listStaleInboundEvents,
  listUndeliveredFollowUps,
  loadTriageContext,
  markMessagesDeliveredViaTicket,
  recordFollowUpDelivered,
  recordReplyWarning,
  requestHasEvent,
  resolveExternalReply,
  type SupportDb,
  storeInternalComment,
  type TicketRow,
} from "@pw-support/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  buildHoldWarning,
  classifyStaffComment,
  isConfirmComment,
  isSystemComment,
} from "../reply/marker";
import type { WordingScorer } from "../reply/wording";
import type { LinearClient } from "./client";
import {
  buildFollowUpComment,
  buildTicket,
  messageMarker,
  requestMarker,
} from "./ticket";

export const LINEAR_ADAPTER_NAME = "linear";

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
}

interface WordingDecision {
  score: number;
  band: ReplyBand;
  holdReason?: ReplyHoldReason;
  raw: Record<string, unknown>;
}

const inboundPayloadSchema = z.object({ inboundId: z.string().uuid() });

export function createLinearAdapter(deps: LinearAdapterDeps): LinearAdapter {
  const { db, linear } = deps;
  const clock = deps.now ?? (() => new Date());

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
    if (isSystemComment(inbound.body)) return true;
    if (await isRecordedOwnComment(db, inbound.commentId)) return true;
    return (
      inbound.authorId !== null && inbound.authorId === (await linear.viewerId())
    );
  }

  async function ensureHoldWarning(inbound: InboundCommentRow): Promise<void> {
    const reply = await getReplyByInbound(db, inbound.id);
    if (!reply || reply.status !== "held" || reply.warningCommentId) return;
    const warning = await linear.createComment(
      inbound.issueId,
      buildHoldWarning({
        reason: (reply.holdReason ?? "wording_low") as ReplyHoldReason,
        score: reply.wordingScore,
        maxChars: MAX_MESSAGE_CHARS,
      }),
      reply.threadRootId,
    );
    await recordReplyWarning(db, reply.id, warning.id);
  }

  async function processInboundComment(inboundId: string): Promise<void> {
    const inbound = await getInboundComment(db, inboundId);
    if (!inbound) return;
    if (inbound.status === "processed") {
      await ensureHoldWarning(inbound);
      return;
    }
    if (await isOwnComment(inbound)) {
      await ignoreInboundComment(db, inbound.id, "own_comment");
      return;
    }
    if (inbound.parentCommentId && isConfirmComment(inbound.body)) {
      await confirmHeldReply(db, { inboundId: inbound.id, now: clock() });
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
      let delivered = 0;
      for (const item of pending) {
        if (!item.ready) break;
        const found = await linear.findCommentByMarker(
          ticket.linearIssueId,
          messageMarker(item.message.id),
        );
        const comment =
          found ??
          (await linear.createComment(
            ticket.linearIssueId,
            buildFollowUpComment({
              messageId: item.message.id,
              originChannel: item.message.originChannel,
              text: displayBody(item.message),
              attachmentNames: item.attachmentNames,
            }),
          ));
        await recordFollowUpDelivered(tx, {
          messageId: item.message.id,
          requestId,
          linearCommentId: comment.id,
          now: clock(),
        });
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
        customerText: context.messages.map((m) => m.body).join("\n\n"),
        attachments: context.attachments.map((file) => ({
          filename: file.filename,
          notAnalyzed: withheld.has(`image:${file.id}`),
        })),
      });
      const labelIds: string[] = [];
      for (const name of draft.labelNames) {
        labelIds.push(await linear.findOrCreateLabel(teamId, name));
      }
      const issue =
        (await linear.findIssueByMarker(teamId, requestMarker(requestId))) ??
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
      await markMessagesDeliveredViaTicket(
        tx,
        requestId,
        context.messages.map((message) => message.id),
        clock(),
      );
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
      "comment.received",
    ],
    async handle(event: EventEnvelope) {
      if (event.type === "comment.received") {
        const payload = inboundPayloadSchema.safeParse(event.payload);
        if (payload.success) await processInboundComment(payload.data.inboundId);
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
      return [
        ...(await claimTicketRedeliveries(db, { now })),
        ...(await claimFollowUpRedeliveries(db, { now })),
        ...(await listStaleInboundEvents(db, { now })),
      ];
    },
    createTicketForRequest,
    syncFollowUps,
    processInboundComment,
  };
}
