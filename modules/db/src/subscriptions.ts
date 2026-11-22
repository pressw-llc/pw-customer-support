import {
  channelPrefixSchema,
  defaultTiming,
  type EngineerRequestDetail,
  type EngineerRequestSummary,
  MCP_MAX_SUBSCRIPTIONS,
  type StaffIdentity,
  type TriageTiming,
} from "@pw-support/contracts";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import { inTransaction, type SupportExecutor } from "./client";
import { appendEvent } from "./events";
import { events, subscriptions } from "./schema";

export type SubscriptionRow = typeof subscriptions.$inferSelect;

export class SubscriptionLimitError extends Error {
  constructor() {
    super("subscription limit reached");
    this.name = "SubscriptionLimitError";
  }
}

function matchesPrefix(channelKey: SQL, prefix: SQL) {
  return sql`(${channelKey} = ${prefix} or left(${channelKey}, length(${prefix}) + 1) = ${prefix} || ':')`;
}

function subscribedTo(channelKey: SQL, engineerSub: string) {
  return sql`exists (
    select 1 from support.subscriptions s
    where s.engineer_sub = ${engineerSub}
      and ${matchesPrefix(channelKey, sql.raw("s.channel_prefix"))}
  )`;
}

export async function listSubscriptions(
  db: SupportExecutor,
  engineerSub: string,
): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.engineerSub, engineerSub))
    .orderBy(asc(subscriptions.channelPrefix));
}

export async function addSubscription(
  db: SupportExecutor,
  engineer: StaffIdentity,
  prefix: string,
): Promise<{ subscription: SubscriptionRow; created: boolean }> {
  const channelPrefix = channelPrefixSchema.parse(prefix);
  return inTransaction(db, async (tx) => {
    const existing = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.engineerSub, engineer.sub),
          eq(subscriptions.channelPrefix, channelPrefix),
        ),
      );
    if (existing[0]) return { subscription: existing[0], created: false };
    const count = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(eq(subscriptions.engineerSub, engineer.sub));
    if ((count[0]?.total ?? 0) >= MCP_MAX_SUBSCRIPTIONS) {
      throw new SubscriptionLimitError();
    }
    const [inserted] = await tx
      .insert(subscriptions)
      .values({
        engineerSub: engineer.sub,
        engineerEmail: engineer.email,
        channelPrefix,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const [row] = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.engineerSub, engineer.sub),
            eq(subscriptions.channelPrefix, channelPrefix),
          ),
        );
      return { subscription: row as SubscriptionRow, created: false };
    }
    await appendEvent(tx, {
      type: "mcp.subscription.added",
      channelKey: channelPrefix,
      payload: { engineer: engineer.sub, email: engineer.email },
    });
    return { subscription: inserted, created: true };
  });
}

export async function removeSubscription(
  db: SupportExecutor,
  engineer: StaffIdentity,
  prefix: string,
): Promise<boolean> {
  const channelPrefix = channelPrefixSchema.parse(prefix);
  return inTransaction(db, async (tx) => {
    const removed = await tx
      .delete(subscriptions)
      .where(
        and(
          eq(subscriptions.engineerSub, engineer.sub),
          eq(subscriptions.channelPrefix, channelPrefix),
        ),
      )
      .returning({ id: subscriptions.id });
    if (removed.length === 0) return false;
    await appendEvent(tx, {
      type: "mcp.subscription.removed",
      channelKey: channelPrefix,
      payload: { engineer: engineer.sub, email: engineer.email },
    });
    return true;
  });
}

export interface OfferOptions {
  now?: () => Date;
  timing?: TriageTiming;
  limit?: number;
}

export interface JobOfferRow {
  jobId: string;
  channelKey: string;
  createdAt: Date;
  cloudAvailableAt: Date;
}

function offerPredicate(engineerSub: string, now: Date, timing: TriageTiming) {
  const nowTs = now.toISOString();
  return sql`
    j.status = 'open'
    and j.laptop_claimed_at is null
    and (
      j.intake_completed_at is not null
      or j.created_at <= ${nowTs}::timestamptz - make_interval(secs => ${timing.intakeGraceSeconds})
    )
    and ${subscribedTo(sql.raw("j.channel_key"), engineerSub)}
  `;
}

export async function listJobOffers(
  db: SupportExecutor,
  engineerSub: string,
  options: OfferOptions = {},
): Promise<JobOfferRow[]> {
  const now = (options.now ?? (() => new Date()))();
  const timing = options.timing ?? defaultTiming;
  const rows = await db.execute<{
    id: string;
    channel_key: string;
    created_at: Date;
    cloud_available_at: Date;
  }>(sql`
    select j.id, j.channel_key, j.created_at, j.cloud_available_at
    from support.triage_jobs j
    where ${offerPredicate(engineerSub, now, timing)}
    order by j.created_at asc
    limit ${options.limit ?? 20}
  `);
  return rows.map((row) => ({
    jobId: row.id,
    channelKey: row.channel_key,
    createdAt: new Date(row.created_at),
    cloudAvailableAt: new Date(row.cloud_available_at),
  }));
}

export async function isJobOffered(
  db: SupportExecutor,
  engineerSub: string,
  jobId: string,
  options: OfferOptions = {},
): Promise<boolean> {
  const now = (options.now ?? (() => new Date()))();
  const timing = options.timing ?? defaultTiming;
  const rows = await db.execute(sql`
    select 1 from support.triage_jobs j
    where j.id = ${jobId} and ${offerPredicate(engineerSub, now, timing)}
  `);
  return rows.length > 0;
}

type SummaryRaw = {
  id: string;
  channel_key: string;
  status: string;
  created_at: Date;
  subscribed: boolean;
  job_status: string | null;
  job_outcome: string | null;
  job_claimed_kind: string | null;
  job_lease_expires_at: Date | null;
  ticket_identifier: string | null;
  ticket_url: string | null;
  held: boolean;
  flagged: boolean;
};

function toSummary(raw: SummaryRaw): EngineerRequestSummary {
  return {
    id: raw.id,
    channelKey: raw.channel_key,
    status: raw.status,
    createdAt: new Date(raw.created_at).toISOString(),
    subscribed: raw.subscribed,
    job: raw.job_status
      ? {
          status: raw.job_status,
          outcome: raw.job_outcome,
          claimedByKind: raw.job_claimed_kind,
          leaseExpiresAt: raw.job_lease_expires_at
            ? new Date(raw.job_lease_expires_at).toISOString()
            : null,
        }
      : null,
    ticket:
      raw.ticket_identifier && raw.ticket_url
        ? { identifier: raw.ticket_identifier, url: raw.ticket_url }
        : null,
    heldReplies: raw.held,
    flaggedReplies: raw.flagged,
  };
}

function selectSummary(engineerSub: string) {
  return sql`
    select
      r.id, r.channel_key, r.status, r.created_at,
      ${subscribedTo(sql.raw("r.channel_key"), engineerSub)} as subscribed,
      j.status as job_status, j.outcome as job_outcome,
      j.claimed_by_kind as job_claimed_kind,
      j.lease_expires_at as job_lease_expires_at,
      t.identifier as ticket_identifier, t.url as ticket_url,
      exists (select 1 from support.replies rp
        where rp.request_id = r.id and rp.status = 'held'
          and rp.expires_at > now()) as held,
      exists (select 1 from support.replies rp
        where rp.request_id = r.id and rp.flagged) as flagged
    from support.requests r
    left join support.triage_jobs j on j.request_id = r.id
    left join support.tickets t on t.request_id = r.id
  `;
}

export interface RequestQuery {
  channelPrefix?: string;
  status?: string;
  limit: number;
}

export async function queryRequestSummaries(
  db: SupportExecutor,
  engineerSub: string,
  query: RequestQuery,
): Promise<EngineerRequestSummary[]> {
  const conditions = [sql`true`];
  if (query.channelPrefix) {
    const prefix = channelPrefixSchema.parse(query.channelPrefix);
    conditions.push(matchesPrefix(sql.raw("r.channel_key"), sql`${prefix}`));
  }
  if (query.status) conditions.push(sql`r.status = ${query.status}`);
  const rows = await db.execute<SummaryRaw>(sql`
    ${selectSummary(engineerSub)}
    where ${sql.join(conditions, sql` and `)}
    order by r.created_at desc, r.id desc
    limit ${query.limit}
  `);
  return rows.map(toSummary);
}

export const DETAIL_MAX_MESSAGES = 20;
export const DETAIL_MAX_BODY_CHARS = 4000;
export const DETAIL_MAX_EVENTS = 100;

export async function getRequestDetailForEngineer(
  db: SupportExecutor,
  engineerSub: string,
  requestId: string,
): Promise<EngineerRequestDetail | null> {
  const rows = await db.execute<SummaryRaw>(sql`
    ${selectSummary(engineerSub)}
    where r.id = ${requestId}
  `);
  const raw = rows[0];
  if (!raw) return null;
  const request = toSummary(raw);
  const timeline = await db
    .select({ type: events.type, createdAt: events.createdAt })
    .from(events)
    .where(eq(events.requestId, requestId))
    .orderBy(asc(events.seq))
    .limit(DETAIL_MAX_EVENTS);
  let messages: EngineerRequestDetail["messages"] = null;
  if (request.subscribed) {
    const thread = await db.execute<{
      author: string;
      created_at: Date;
      body: string;
    }>(sql`
      select author, created_at, coalesce(sanitized_body, body) as body
      from support.messages
      where request_id = ${requestId} and audience = 'external'
      order by created_at asc, id asc
      limit ${DETAIL_MAX_MESSAGES}
    `);
    messages = thread.map((row) => ({
      author: row.author,
      createdAt: new Date(row.created_at).toISOString(),
      body: row.body.slice(0, DETAIL_MAX_BODY_CHARS),
    }));
  }
  return {
    request,
    events: timeline.map((row) => ({
      type: row.type,
      createdAt: row.createdAt.toISOString(),
    })),
    messages,
  };
}
