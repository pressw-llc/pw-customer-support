import type { EventEnvelope, EventType } from "@pw-support/contracts";
import { eventEnvelopeSchema } from "@pw-support/contracts";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { SupportExecutor } from "./client";
import type { Project } from "./projects";
import {
  attachments,
  eventCursors,
  events,
  judgments,
  messages,
  projects,
  requests,
  tickets,
} from "./schema";

export type TicketRow = typeof tickets.$inferSelect;
export type AttachmentRecord = typeof attachments.$inferSelect;

export interface TriageContext {
  request: typeof requests.$inferSelect;
  project: Project;
  messages: { id: string; body: string; createdAt: Date }[];
  attachments: AttachmentRecord[];
}

export async function loadTriageContext(
  db: SupportExecutor,
  requestId: string,
): Promise<TriageContext | null> {
  const [row] = await db
    .select({ request: requests, project: projects })
    .from(requests)
    .innerJoin(projects, eq(projects.id, requests.projectId))
    .where(eq(requests.id, requestId));
  if (!row) return null;
  const thread = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.requestId, requestId),
        eq(messages.author, "customer"),
        eq(messages.audience, "external"),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const files =
    thread.length === 0
      ? []
      : await db
          .select()
          .from(attachments)
          .where(
            inArray(
              attachments.messageId,
              thread.map((message) => message.id),
            ),
          )
          .orderBy(asc(attachments.createdAt), asc(attachments.id));
  return {
    request: row.request,
    project: row.project,
    messages: thread.map((message) => ({
      id: message.id,
      body: message.sanitizedBody ?? message.body,
      createdAt: message.createdAt,
    })),
    attachments: files,
  };
}

export async function setProjectLinearTeam(
  db: SupportExecutor,
  input: { clientSlug: string; projectSlug: string; linearTeamId: string | null },
): Promise<boolean> {
  const rows = await db
    .update(projects)
    .set({ linearTeamId: input.linearTeamId })
    .where(
      and(
        eq(projects.clientSlug, input.clientSlug),
        eq(projects.projectSlug, input.projectSlug),
      ),
    )
    .returning({ id: projects.id });
  return rows.length > 0;
}

export interface JudgmentInput {
  requestId: string;
  kind: string;
  subject: string;
  score: number;
  threshold: number;
  flagged: boolean;
  raw: Record<string, unknown>;
}

export async function recordJudgments(
  db: SupportExecutor,
  rows: JudgmentInput[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(judgments).values(rows);
}

export async function listJudgments(
  db: SupportExecutor,
  requestId: string,
): Promise<(typeof judgments.$inferSelect)[]> {
  return db
    .select()
    .from(judgments)
    .where(eq(judgments.requestId, requestId))
    .orderBy(asc(judgments.createdAt));
}

export async function findTicketByRequest(
  db: SupportExecutor,
  requestId: string,
): Promise<TicketRow | null> {
  const [row] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.requestId, requestId));
  return row ?? null;
}

export async function insertTicket(
  db: SupportExecutor,
  input: {
    requestId: string;
    linearIssueId: string;
    identifier: string;
    url: string;
  },
): Promise<TicketRow | null> {
  const [row] = await db
    .insert(tickets)
    .values(input)
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function readEventsAfter(
  db: SupportExecutor,
  input: { afterSeq: number; types: readonly EventType[]; limit?: number },
): Promise<EventEnvelope[]> {
  if (input.types.length === 0) return [];
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        gt(events.seq, input.afterSeq),
        inArray(events.type, [...input.types]),
      ),
    )
    .orderBy(asc(events.seq))
    .limit(input.limit ?? 100);
  return rows.map((row) => eventEnvelopeSchema.parse(row));
}

export async function getEventBySeq(
  db: SupportExecutor,
  seq: number,
): Promise<EventEnvelope | null> {
  const [row] = await db.select().from(events).where(eq(events.seq, seq));
  return row ? eventEnvelopeSchema.parse(row) : null;
}

export async function maxEventSeq(db: SupportExecutor): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${events.seq}), 0)::int` })
    .from(events);
  return row?.max ?? 0;
}

export async function getEventCursor(
  db: SupportExecutor,
  adapter: string,
): Promise<number> {
  const [row] = await db
    .select()
    .from(eventCursors)
    .where(eq(eventCursors.adapter, adapter));
  return row?.lastSeq ?? 0;
}

export async function advanceEventCursor(
  db: SupportExecutor,
  adapter: string,
  seq: number,
): Promise<void> {
  await db
    .insert(eventCursors)
    .values({ adapter, lastSeq: seq })
    .onConflictDoUpdate({
      target: eventCursors.adapter,
      set: {
        lastSeq: sql`greatest(${eventCursors.lastSeq}, excluded.last_seq)`,
        updatedAt: sql`now()`,
      },
    });
}
