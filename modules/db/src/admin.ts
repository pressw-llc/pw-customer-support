import {
  ADMIN_CHANNEL_KEY,
  type AdminRequestFilters,
  formatChannelKey,
  type IntegrationKind,
  PREVIEW_CHARS,
  type StaffIdentity,
} from "@pw-support/contracts";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SupportDb, SupportExecutor } from "./client";
import { appendEvent } from "./events";
import { generateProjectKey, type Project } from "./projects";
import {
  attachmentRejections,
  attachments,
  events,
  integrations,
  judgments,
  messages,
  projectKeys,
  projects,
  triageJobs,
} from "./schema";

export const ACK_STAFF_PREDICATE = sql`m.author = 'staff' and (m.origin_channel = 'linear' or m.audience = 'external')`;

export interface AdminRequestRow {
  id: string;
  projectId: string;
  clientSlug: string;
  projectSlug: string;
  hashedId: string;
  channelKey: string;
  status: string;
  createdAt: Date;
  createdAtRaw: string;
  acknowledgedAt: Date | null;
  ticketIdentifier: string | null;
  ticketUrl: string | null;
  triageOutcome: string | null;
  needsHumanTriage: boolean;
  flaggedReplies: boolean;
  heldReplies: boolean;
  preview: string;
}

interface RawRow {
  id: string;
  project_id: string;
  client_slug: string;
  project_slug: string;
  hashed_id: string;
  channel_key: string;
  status: string;
  created_at: Date;
  created_at_raw: string;
  acknowledged_at: Date | null;
  ticket_identifier: string | null;
  ticket_url: string | null;
  triage_outcome: string | null;
  needs_human: boolean;
  flagged: boolean;
  held: boolean;
  body: string | null;
}

function toRow(raw: RawRow): AdminRequestRow {
  return {
    id: raw.id,
    projectId: raw.project_id,
    clientSlug: raw.client_slug,
    projectSlug: raw.project_slug,
    hashedId: raw.hashed_id,
    channelKey: raw.channel_key,
    status: raw.status,
    createdAt: new Date(raw.created_at),
    createdAtRaw: raw.created_at_raw,
    acknowledgedAt: raw.acknowledged_at ? new Date(raw.acknowledged_at) : null,
    ticketIdentifier: raw.ticket_identifier,
    ticketUrl: raw.ticket_url,
    triageOutcome: raw.triage_outcome,
    needsHumanTriage: raw.needs_human,
    flaggedReplies: raw.flagged,
    heldReplies: raw.held,
    preview: (raw.body ?? "").slice(0, PREVIEW_CHARS),
  };
}

const SELECT_REQUEST = sql`
  select
    r.id, r.project_id, p.client_slug, p.project_slug, c.hashed_id,
    r.channel_key, r.status, r.created_at, r.created_at::text as created_at_raw,
    (select min(m.created_at) from support.messages m
      where m.request_id = r.id and ${ACK_STAFF_PREDICATE}) as acknowledged_at,
    t.identifier as ticket_identifier, t.url as ticket_url,
    j.outcome as triage_outcome,
    coalesce(j.outcome = 'human_triage' or j.result->>'needs_human' = 'true', false) as needs_human,
    exists (select 1 from support.events e
      where e.request_id = r.id and e.type = 'reply.flagged') as flagged,
    exists (select 1 from support.events e
      where e.request_id = r.id and e.type = 'reply.held') as held,
    first_message.body
  from support.requests r
  join support.projects p on p.id = r.project_id
  join support.customers c on c.id = r.customer_id
  left join support.tickets t on t.request_id = r.id
  left join support.triage_jobs j on j.request_id = r.id
  left join lateral (
    select coalesce(m.sanitized_body, m.body) as body
    from support.messages m
    where m.request_id = r.id and m.author = 'customer'
    order by m.created_at, m.id
    limit 1
  ) first_message on true
`;

export function encodeCursor(row: {
  createdAtRaw: string;
  id: string;
}): string {
  return Buffer.from(`${row.createdAtRaw}|${row.id}`).toString("base64url");
}

export function decodeCursor(
  cursor: string,
): { createdAtRaw: string; id: string } | null {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const [createdAtRaw, id] = text.split("|");
  const uuid = /^[0-9a-f-]{36}$/i;
  const stamp = /^\d{4}-\d{2}-\d{2} [\d:.]+(\+|-)\d{2}(:\d{2})?$/;
  if (!createdAtRaw || !id || !uuid.test(id) || !stamp.test(createdAtRaw)) {
    return null;
  }
  return { createdAtRaw, id };
}

export async function listAdminRequests(
  db: SupportExecutor,
  filters: AdminRequestFilters,
): Promise<{ rows: AdminRequestRow[]; nextCursor: string | null }> {
  const conditions = [sql`true`];
  if (filters.projectId)
    conditions.push(sql`r.project_id = ${filters.projectId}`);
  if (filters.status) conditions.push(sql`r.status = ${filters.status}`);
  if (filters.flaggedReplies !== undefined) {
    const exists = sql`exists (select 1 from support.events e
      where e.request_id = r.id and e.type in ('reply.flagged', 'reply.held'))`;
    conditions.push(filters.flaggedReplies ? exists : sql`not ${exists}`);
  }
  if (filters.needsHuman !== undefined) {
    const human = sql`coalesce(j.outcome = 'human_triage' or j.result->>'needs_human' = 'true', false)`;
    conditions.push(filters.needsHuman ? human : sql`not ${human}`);
  }
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  if (cursor) {
    conditions.push(
      sql`(r.created_at, r.id) < (${cursor.createdAtRaw}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const result = await db.execute(sql`
    ${SELECT_REQUEST}
    where ${sql.join(conditions, sql` and `)}
    order by r.created_at desc, r.id desc
    limit ${filters.limit + 1}
  `);
  const rows = (result as unknown as RawRow[]).map(toRow);
  const page = rows.slice(0, filters.limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > filters.limit && last ? encodeCursor(last) : null,
  };
}

export async function getAdminRequest(
  db: SupportExecutor,
  requestId: string,
): Promise<AdminRequestRow | null> {
  const result = await db.execute(sql`
    ${SELECT_REQUEST}
    where r.id = ${requestId}
  `);
  const [row] = result as unknown as RawRow[];
  return row ? toRow(row) : null;
}

export type AdminEventRow = typeof events.$inferSelect;

export interface AdminRequestDetailRows {
  request: AdminRequestRow;
  messages: {
    message: typeof messages.$inferSelect;
    attachments: (typeof attachments.$inferSelect)[];
  }[];
  rejections: (typeof attachmentRejections.$inferSelect)[];
  events: AdminEventRow[];
  judgments: (typeof judgments.$inferSelect)[];
  job: typeof triageJobs.$inferSelect | null;
}

export async function getAdminRequestDetail(
  db: SupportExecutor,
  requestId: string,
): Promise<AdminRequestDetailRows | null> {
  const request = await getAdminRequest(db, requestId);
  if (!request) return null;
  const thread = await db
    .select()
    .from(messages)
    .where(eq(messages.requestId, requestId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const ids = thread.map((message) => message.id);
  const [files, rejections, timeline, scored, [job]] = await Promise.all([
    ids.length === 0
      ? []
      : db
          .select()
          .from(attachments)
          .where(inArray(attachments.messageId, ids))
          .orderBy(asc(attachments.createdAt), asc(attachments.id)),
    ids.length === 0
      ? []
      : db
          .select()
          .from(attachmentRejections)
          .where(inArray(attachmentRejections.messageId, ids))
          .orderBy(asc(attachmentRejections.createdAt)),
    db
      .select()
      .from(events)
      .where(eq(events.requestId, requestId))
      .orderBy(asc(events.seq)),
    db
      .select()
      .from(judgments)
      .where(eq(judgments.requestId, requestId))
      .orderBy(asc(judgments.createdAt)),
    db.select().from(triageJobs).where(eq(triageJobs.requestId, requestId)),
  ]);
  return {
    request,
    messages: thread.map((message) => ({
      message,
      attachments: files.filter((file) => file.messageId === message.id),
    })),
    rejections,
    events: timeline,
    judgments: scored,
    job: job ?? null,
  };
}

export async function getAdminAttachment(
  db: SupportExecutor,
  attachmentId: string,
): Promise<typeof attachments.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId));
  return row ?? null;
}

export interface AdminProjectRow {
  project: Project;
  keys: (typeof projectKeys.$inferSelect)[];
}

export async function listAdminProjects(
  db: SupportExecutor,
): Promise<AdminProjectRow[]> {
  const rows = await db
    .select()
    .from(projects)
    .orderBy(asc(projects.clientSlug), asc(projects.projectSlug));
  if (rows.length === 0) return [];
  const keys = await db
    .select()
    .from(projectKeys)
    .where(
      inArray(
        projectKeys.projectId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(desc(projectKeys.createdAt), desc(projectKeys.id));
  return rows.map((project) => ({
    project,
    keys: keys.filter((key) => key.projectId === project.id),
  }));
}

export async function getAdminProject(
  db: SupportExecutor,
  projectId: string,
): Promise<AdminProjectRow | null> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return null;
  const keys = await db
    .select()
    .from(projectKeys)
    .where(eq(projectKeys.projectId, projectId))
    .orderBy(desc(projectKeys.createdAt), desc(projectKeys.id));
  return { project, keys };
}

function actorPayload(actor: StaffIdentity): Record<string, unknown> {
  return { actor: { sub: actor.sub, email: actor.email } };
}

function projectChannelKey(project: {
  clientSlug: string;
  projectSlug: string;
}): string {
  return formatChannelKey({
    client: project.clientSlug,
    project: project.projectSlug,
  });
}

export interface CreateAdminProject {
  clientSlug: string;
  projectSlug: string;
  name: string;
  linearTeamId?: string | null;
}

export async function createAdminProject(
  db: SupportDb,
  input: CreateAdminProject,
  actor: StaffIdentity,
): Promise<Project | null> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({
        clientSlug: input.clientSlug,
        projectSlug: input.projectSlug,
        name: input.name,
        linearTeamId: input.linearTeamId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!project) return null;
    await appendEvent(tx, {
      type: "admin.project.created",
      channelKey: projectChannelKey(project),
      payload: {
        ...actorPayload(actor),
        projectId: project.id,
        linearTeamId: project.linearTeamId,
      },
    });
    return project;
  });
}

export async function updateAdminProject(
  db: SupportDb,
  projectId: string,
  input: { name?: string; linearTeamId?: string | null },
  actor: StaffIdentity,
): Promise<Project | null> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .update(projects)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.linearTeamId === undefined
          ? {}
          : { linearTeamId: input.linearTeamId }),
      })
      .where(eq(projects.id, projectId))
      .returning();
    if (!project) return null;
    await appendEvent(tx, {
      type: "admin.project.updated",
      channelKey: projectChannelKey(project),
      payload: {
        ...actorPayload(actor),
        projectId: project.id,
        fields: Object.keys(input),
        linearTeamId: project.linearTeamId,
      },
    });
    return project;
  });
}

export async function setProjectCcList(
  db: SupportDb,
  projectId: string,
  emails: string[],
  actor: StaffIdentity,
): Promise<Project | null> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .update(projects)
      .set({ severeCcEmails: emails })
      .where(eq(projects.id, projectId))
      .returning();
    if (!project) return null;
    await appendEvent(tx, {
      type: "admin.cc_list.updated",
      channelKey: projectChannelKey(project),
      payload: {
        ...actorPayload(actor),
        projectId: project.id,
        count: emails.length,
      },
    });
    return project;
  });
}

export async function mintProjectKey(
  db: SupportDb,
  projectId: string,
  actor: StaffIdentity,
): Promise<{ id: string; key: string; createdAt: Date } | null> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) return null;
    const [row] = await tx
      .insert(projectKeys)
      .values({ projectId, key: generateProjectKey() })
      .returning();
    if (!row) throw new Error("expected a key row");
    await appendEvent(tx, {
      type: "admin.key.minted",
      channelKey: projectChannelKey(project),
      payload: { ...actorPayload(actor), projectId, keyId: row.id },
    });
    return { id: row.id, key: row.key, createdAt: row.createdAt };
  });
}

export async function revokeProjectKey(
  db: SupportDb,
  projectId: string,
  keyId: string,
  actor: StaffIdentity,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) return false;
    const revoked = await tx
      .update(projectKeys)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(projectKeys.id, keyId),
          eq(projectKeys.projectId, projectId),
          isNull(projectKeys.revokedAt),
        ),
      )
      .returning({ id: projectKeys.id });
    if (revoked.length === 0) return false;
    await appendEvent(tx, {
      type: "admin.key.revoked",
      channelKey: projectChannelKey(project),
      payload: { ...actorPayload(actor), projectId, keyId },
    });
    return true;
  });
}

export type IntegrationRow = typeof integrations.$inferSelect;

export async function listIntegrations(
  db: SupportExecutor,
  scope: string,
): Promise<IntegrationRow[]> {
  return db.select().from(integrations).where(eq(integrations.scope, scope));
}

export async function getIntegration(
  db: SupportExecutor,
  scope: string,
  kind: IntegrationKind,
): Promise<IntegrationRow | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.scope, scope), eq(integrations.kind, kind)));
  return row ?? null;
}

export async function recordIntegration(
  db: SupportDb,
  input: {
    scope: string;
    kind: IntegrationKind;
    secretRef: string;
  },
  actor: StaffIdentity,
): Promise<IntegrationRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(integrations)
      .values({
        scope: input.scope,
        kind: input.kind,
        secretRef: input.secretRef,
        updatedBy: actor.email ?? actor.sub,
      })
      .onConflictDoUpdate({
        target: [integrations.scope, integrations.kind],
        set: {
          secretRef: input.secretRef,
          updatedAt: sql`now()`,
          updatedBy: actor.email ?? actor.sub,
        },
      })
      .returning();
    if (!row) throw new Error("expected an integration row");
    await appendEvent(tx, {
      type: "admin.integration.updated",
      channelKey: ADMIN_CHANNEL_KEY,
      payload: {
        ...actorPayload(actor),
        scope: input.scope,
        kind: input.kind,
      },
    });
    return row;
  });
}
