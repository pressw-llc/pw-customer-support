import {
  type ClaimantKind,
  defaultTiming,
  delayChannelFor,
  type HumanTriageReason,
  halveDelay,
  humanTriageResult,
  type TriageOutcome,
  type TriageResult,
  type TriageTiming,
  triageResultSchema,
} from "@pw-support/contracts";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { inTransaction, type SupportExecutor } from "./client";
import { appendEvent } from "./events";
import { channelDelays, triageJobs } from "./schema";

export type TriageJob = typeof triageJobs.$inferSelect;
export type Clock = () => Date;

export interface JobOptions {
  now?: Clock;
  timing?: TriageTiming;
}

const systemClock: Clock = () => new Date();

function clockOf(options: JobOptions): Date {
  return (options.now ?? systemClock)();
}

function timingOf(options: JobOptions): TriageTiming {
  return options.timing ?? defaultTiming;
}

function plusSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function required<T>(row: T | undefined | null): T {
  if (row === undefined || row === null) throw new Error("expected a row");
  return row;
}

export async function openTriageJob(
  tx: SupportExecutor,
  request: { id: string; channelKey: string },
  options: JobOptions = {},
): Promise<{ job: TriageJob; delaySeconds: number }> {
  const now = clockOf(options);
  const timing = timingOf(options);
  const delayChannel = delayChannelFor(request.channelKey);
  await tx
    .insert(channelDelays)
    .values({
      delayChannel,
      currentDelaySeconds: timing.initialDelaySeconds,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const delayRow = required(
    (
      await tx
        .select()
        .from(channelDelays)
        .where(eq(channelDelays.delayChannel, delayChannel))
    )[0],
  );
  const delaySeconds = delayRow.currentDelaySeconds;
  const cloudAvailableAt = plusSeconds(now, delaySeconds);
  const [row] = await tx
    .insert(triageJobs)
    .values({
      requestId: request.id,
      channelKey: request.channelKey,
      delayChannel,
      cloudAvailableAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const job = required(row);
  await appendEvent(tx, {
    type: "triage.job.opened",
    channelKey: request.channelKey,
    requestId: request.id,
    payload: {
      jobId: job.id,
      delaySeconds,
      cloudAvailableAt: cloudAvailableAt.toISOString(),
    },
  });
  return { job, delaySeconds };
}

export async function markIntakeComplete(
  db: SupportExecutor,
  requestId: string,
  now: Clock = systemClock,
): Promise<void> {
  await db
    .update(triageJobs)
    .set({ intakeCompletedAt: now() })
    .where(eq(triageJobs.requestId, requestId));
}

export async function getTriageJob(
  db: SupportExecutor,
  jobId: string,
): Promise<TriageJob | null> {
  const [row] = await db
    .select()
    .from(triageJobs)
    .where(eq(triageJobs.id, jobId));
  return row ?? null;
}

export async function getTriageJobForRequest(
  db: SupportExecutor,
  requestId: string,
): Promise<TriageJob | null> {
  const [row] = await db
    .select()
    .from(triageJobs)
    .where(eq(triageJobs.requestId, requestId));
  return row ?? null;
}

export async function getChannelDelay(
  db: SupportExecutor,
  delayChannel: string,
): Promise<number | null> {
  const [row] = await db
    .select()
    .from(channelDelays)
    .where(eq(channelDelays.delayChannel, delayChannel));
  return row?.currentDelaySeconds ?? null;
}

export type Availability =
  | { state: "completed" }
  | { state: "leased"; waitSeconds: number }
  | { state: "waiting"; waitSeconds: number }
  | { state: "claimable" };

function intakeReady(job: TriageJob, now: Date, timing: TriageTiming) {
  return (
    job.intakeCompletedAt !== null ||
    job.createdAt.getTime() <=
      plusSeconds(now, -timing.intakeGraceSeconds).getTime()
  );
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

export function cloudAvailability(
  job: TriageJob,
  now: Date,
  timing: TriageTiming = defaultTiming,
): Availability {
  if (job.status === "completed") return { state: "completed" };
  if (job.status === "claimed") {
    const lease = job.leaseExpiresAt as Date;
    return lease.getTime() > now.getTime()
      ? { state: "leased", waitSeconds: secondsUntil(lease, now) + 1 }
      : { state: "claimable" };
  }
  if (!intakeReady(job, now, timing)) {
    const ready = plusSeconds(job.createdAt, timing.intakeGraceSeconds);
    return {
      state: "waiting",
      waitSeconds: Math.min(5, secondsUntil(ready, now)),
    };
  }
  if (job.cloudAvailableAt.getTime() > now.getTime()) {
    return {
      state: "waiting",
      waitSeconds: secondsUntil(job.cloudAvailableAt, now),
    };
  }
  return { state: "claimable" };
}

export interface ClaimInput extends JobOptions {
  jobId: string;
  kind: ClaimantKind;
  claimant: string;
}

export type ClaimResult =
  | { won: true; job: TriageJob; tookOverExpiredLease: boolean }
  | { won: false };

export async function claimTriageJob(
  db: SupportExecutor,
  input: ClaimInput,
): Promise<ClaimResult> {
  const now = clockOf(input);
  const timing = timingOf(input);
  const nowTs = now.toISOString();
  const run = async (tx: SupportExecutor): Promise<ClaimResult> => {
    const rows = await tx.execute<{
      prev_status: string;
      prev_claimed_by: string | null;
      prev_claimed_kind: string | null;
    }>(sql`
      WITH prev AS (
        SELECT id, status, claimed_by, claimed_by_kind
        FROM support.triage_jobs
        WHERE id = ${input.jobId}
          AND (
            (
              status = 'open'
              AND (
                intake_completed_at IS NOT NULL
                OR created_at <= ${nowTs}::timestamptz - make_interval(secs => ${timing.intakeGraceSeconds})
              )
              AND (${input.kind} = 'laptop' OR cloud_available_at <= ${nowTs}::timestamptz)
            )
            OR (status = 'claimed' AND lease_expires_at <= ${nowTs}::timestamptz)
          )
        FOR UPDATE
      )
      UPDATE support.triage_jobs j
      SET status = 'claimed',
          claimed_by_kind = ${input.kind},
          claimed_by = ${input.claimant},
          claim_token = gen_random_uuid(),
          lease_expires_at = ${nowTs}::timestamptz + make_interval(secs => ${timing.leaseSeconds}),
          attempts = j.attempts + 1,
          laptop_claimed_at = CASE
            WHEN ${input.kind} = 'laptop' THEN COALESCE(j.laptop_claimed_at, ${nowTs}::timestamptz)
            ELSE j.laptop_claimed_at
          END,
          updated_at = ${nowTs}::timestamptz
      FROM prev
      WHERE j.id = prev.id
      RETURNING prev.status AS prev_status,
                prev.claimed_by AS prev_claimed_by,
                prev.claimed_by_kind AS prev_claimed_kind
    `);
    const won = rows[0];
    if (!won) return { won: false };
    const job = required(await getTriageJob(tx, input.jobId));
    const tookOver = won.prev_status === "claimed";
    if (tookOver) {
      await appendEvent(tx, {
        type: "triage.job.lease_expired",
        channelKey: job.channelKey,
        requestId: job.requestId,
        payload: {
          jobId: job.id,
          previousClaimant: won.prev_claimed_by,
          previousKind: won.prev_claimed_kind,
        },
      });
    }
    await appendEvent(tx, {
      type: "triage.job.claimed",
      channelKey: job.channelKey,
      requestId: job.requestId,
      payload: {
        jobId: job.id,
        kind: input.kind,
        claimant: input.claimant,
        attempt: job.attempts,
        leaseExpiresAt: (job.leaseExpiresAt as Date).toISOString(),
      },
    });
    if (input.kind === "laptop") {
      await tx
        .update(channelDelays)
        .set({
          currentDelaySeconds: timing.initialDelaySeconds,
          updatedAt: now,
        })
        .where(eq(channelDelays.delayChannel, job.delayChannel));
    } else if (job.attempts === 1 && job.laptopClaimedAt === null) {
      const current = (
        await tx
          .select()
          .from(channelDelays)
          .where(eq(channelDelays.delayChannel, job.delayChannel))
      )[0];
      if (current) {
        await tx
          .update(channelDelays)
          .set({
            currentDelaySeconds: halveDelay(current.currentDelaySeconds),
            updatedAt: now,
          })
          .where(eq(channelDelays.delayChannel, job.delayChannel));
      }
    }
    return { won: true, job, tookOverExpiredLease: tookOver };
  };
  return inTransaction(db, run);
}

export async function listCloudEligibleJobs(
  db: SupportExecutor,
  options: JobOptions & { limit?: number } = {},
): Promise<TriageJob[]> {
  const now = clockOf(options);
  const timing = timingOf(options);
  const graceCutoff = plusSeconds(now, -timing.intakeGraceSeconds);
  return db
    .select()
    .from(triageJobs)
    .where(
      or(
        and(
          eq(triageJobs.status, "open"),
          lte(triageJobs.cloudAvailableAt, now),
          or(
            sql`${triageJobs.intakeCompletedAt} is not null`,
            lte(triageJobs.createdAt, graceCutoff),
          ),
        ),
        and(
          eq(triageJobs.status, "claimed"),
          lte(triageJobs.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(asc(triageJobs.createdAt))
    .limit(options.limit ?? 50);
}

export type SubmitResult =
  | { ok: true; job: TriageJob }
  | { ok: false; reason: "stale_claim" }
  | {
      ok: false;
      reason: "invalid_payload";
      issues: { path: string; message: string }[];
    };

interface CompleteInput extends JobOptions {
  jobId: string;
  claimToken: string;
  payload: unknown;
  outcome: TriageOutcome;
  humanTriageReason?: HumanTriageReason;
}

const ISSUE_MESSAGE_CHARS = 200;

async function completeClaimed(
  db: SupportExecutor,
  input: CompleteInput,
): Promise<SubmitResult> {
  const now = clockOf(input);
  const run = async (tx: SupportExecutor): Promise<SubmitResult> => {
    const [job] = await tx
      .select()
      .from(triageJobs)
      .where(eq(triageJobs.id, input.jobId))
      .for("update");
    if (job?.status !== "claimed" || job.claimToken !== input.claimToken) {
      return { ok: false, reason: "stale_claim" };
    }
    const parsed = triageResultSchema.safeParse(input.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message.slice(0, ISSUE_MESSAGE_CHARS),
      }));
      await tx
        .update(triageJobs)
        .set({
          status: "open",
          claimToken: null,
          claimedBy: null,
          claimedByKind: null,
          leaseExpiresAt: null,
          cloudAvailableAt: now,
          updatedAt: now,
        })
        .where(eq(triageJobs.id, job.id));
      await appendEvent(tx, {
        type: "triage.result.rejected",
        channelKey: job.channelKey,
        requestId: job.requestId,
        payload: {
          jobId: job.id,
          claimedByKind: job.claimedByKind,
          issues,
        },
      });
      return { ok: false, reason: "invalid_payload", issues };
    }
    const result: { result: TriageResult; humanTriageReason?: string } = {
      result: parsed.data,
    };
    if (input.humanTriageReason) {
      result.humanTriageReason = input.humanTriageReason;
    }
    const [updated] = await tx
      .update(triageJobs)
      .set({
        status: "completed",
        outcome: input.outcome,
        result,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(triageJobs.id, job.id))
      .returning();
    await appendEvent(tx, {
      type: "triage.result.accepted",
      channelKey: job.channelKey,
      requestId: job.requestId,
      payload: {
        jobId: job.id,
        outcome: input.outcome,
        claimedByKind: job.claimedByKind,
        claimedBy: job.claimedBy,
        ...(input.humanTriageReason ? { reason: input.humanTriageReason } : {}),
      },
    });
    return { ok: true, job: required(updated) };
  };
  return inTransaction(db, run);
}

export interface SubmitInput extends JobOptions {
  jobId: string;
  claimToken: string;
  payload: unknown;
}

export function submitTriageResult(
  db: SupportExecutor,
  input: SubmitInput,
): Promise<SubmitResult> {
  return completeClaimed(db, { ...input, outcome: "agent" });
}

export interface HumanTriageInput extends JobOptions {
  jobId: string;
  claimToken: string;
  reason: HumanTriageReason;
}

export function submitHumanTriage(
  db: SupportExecutor,
  input: HumanTriageInput,
): Promise<SubmitResult> {
  return completeClaimed(db, {
    jobId: input.jobId,
    claimToken: input.claimToken,
    now: input.now,
    payload: humanTriageResult(),
    outcome: "human_triage",
    humanTriageReason: input.reason,
  });
}

export async function releaseTriageJob(
  db: SupportExecutor,
  input: JobOptions & { jobId: string; claimToken: string; reason: string },
): Promise<boolean> {
  const now = clockOf(input);
  return inTransaction(db, async (tx) => {
    const rows = await tx
      .update(triageJobs)
      .set({
        status: "open",
        claimToken: null,
        claimedBy: null,
        claimedByKind: null,
        leaseExpiresAt: null,
        cloudAvailableAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(triageJobs.id, input.jobId),
          eq(triageJobs.status, "claimed"),
          eq(triageJobs.claimToken, input.claimToken),
        ),
      )
      .returning();
    const job = rows[0];
    if (!job) return false;
    await appendEvent(tx, {
      type: "triage.job.released",
      channelKey: job.channelKey,
      requestId: job.requestId,
      payload: { jobId: job.id, reason: input.reason },
    });
    return true;
  });
}

export async function extendTriageLease(
  db: SupportExecutor,
  input: JobOptions & { jobId: string; claimToken: string },
): Promise<boolean> {
  const now = clockOf(input);
  const rows = await db
    .update(triageJobs)
    .set({
      leaseExpiresAt: plusSeconds(now, timingOf(input).leaseSeconds),
      updatedAt: now,
    })
    .where(
      and(
        eq(triageJobs.id, input.jobId),
        eq(triageJobs.status, "claimed"),
        eq(triageJobs.claimToken, input.claimToken),
      ),
    )
    .returning({ id: triageJobs.id });
  return rows.length > 0;
}

export async function recordAgentSession(
  db: SupportExecutor,
  input: { jobId: string; claimToken: string; sessionId: string },
): Promise<void> {
  await db
    .update(triageJobs)
    .set({ agentSessionId: input.sessionId })
    .where(
      and(
        eq(triageJobs.id, input.jobId),
        eq(triageJobs.claimToken, input.claimToken),
      ),
    );
}
