import {
  type ChannelAdapter,
  type EventEnvelope,
  type HumanTriageReason,
  humanTriageReasonSchema,
  triageOutcomeSchema,
  triageResultSchema,
} from "@pw-support/contracts";
import {
  appendEvent,
  claimTicketRedeliveries,
  findTicketByRequest,
  getTriageJobForRequest,
  insertTicket,
  inTransaction,
  listJudgments,
  loadTriageContext,
  requestHasEvent,
  type SupportDb,
  type TicketRow,
} from "@pw-support/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { LinearClient } from "./client";
import { buildTicket, requestMarker } from "./ticket";

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
  now?: () => Date;
}

export interface LinearAdapter extends ChannelAdapter {
  createTicketForRequest(requestId: string): Promise<TicketOutcome>;
}

export function createLinearAdapter(deps: LinearAdapterDeps): LinearAdapter {
  const { db, linear } = deps;
  const clock = deps.now ?? (() => new Date());

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
    subscribes: ["triage.result.accepted"],
    async handle(event: EventEnvelope) {
      if (!event.requestId) return;
      await createTicketForRequest(event.requestId);
    },
    redeliver: () => claimTicketRedeliveries(db, { now: clock() }),
    createTicketForRequest,
  };
}
