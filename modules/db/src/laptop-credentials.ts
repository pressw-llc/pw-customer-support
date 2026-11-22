import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { SupportExecutor } from "./client";
import { triageJobs, watcherCredentials } from "./schema";
import type { Clock, TriageJob } from "./triage-jobs";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

const systemClock: Clock = () => new Date();

export async function registerWatcher(
  db: SupportExecutor,
  input: { engineerSub: string; machineId: string; secret: string },
): Promise<void> {
  const secretHash = hashSecret(input.secret);
  await db
    .insert(watcherCredentials)
    .values({
      engineerSub: input.engineerSub,
      machineId: input.machineId,
      secretHash,
    })
    .onConflictDoUpdate({
      target: [watcherCredentials.engineerSub, watcherCredentials.machineId],
      set: { secretHash, revokedAt: null, createdAt: new Date() },
    });
}

export async function revokeWatcher(
  db: SupportExecutor,
  input: { engineerSub: string; machineId: string },
): Promise<boolean> {
  const rows = await db
    .update(watcherCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(watcherCredentials.engineerSub, input.engineerSub),
        eq(watcherCredentials.machineId, input.machineId),
        isNull(watcherCredentials.revokedAt),
      ),
    )
    .returning({ machineId: watcherCredentials.machineId });
  return rows.length > 0;
}

export async function isWatcherValid(
  db: SupportExecutor,
  input: { engineerSub: string; machineId: string; secret: string },
): Promise<boolean> {
  const rows = await db
    .select({ machineId: watcherCredentials.machineId })
    .from(watcherCredentials)
    .where(
      and(
        eq(watcherCredentials.engineerSub, input.engineerSub),
        eq(watcherCredentials.machineId, input.machineId),
        eq(watcherCredentials.secretHash, hashSecret(input.secret)),
        isNull(watcherCredentials.revokedAt),
      ),
    );
  return rows.length > 0;
}

export async function setSubmitCredential(
  db: SupportExecutor,
  input: {
    jobId: string;
    claimToken: string;
    secret: string;
    now?: Clock;
  },
): Promise<boolean> {
  const now = (input.now ?? systemClock)();
  const rows = await db
    .update(triageJobs)
    .set({ submitTokenHash: hashSecret(input.secret) })
    .where(
      and(
        eq(triageJobs.id, input.jobId),
        eq(triageJobs.status, "claimed"),
        eq(triageJobs.claimToken, input.claimToken),
        gt(triageJobs.leaseExpiresAt, now),
      ),
    )
    .returning({ id: triageJobs.id });
  return rows.length > 0;
}

export async function findJobBySubmitCredential(
  db: SupportExecutor,
  input: { secret: string; now?: Clock },
): Promise<TriageJob | null> {
  const now = (input.now ?? systemClock)();
  const rows = await db
    .select()
    .from(triageJobs)
    .where(
      and(
        eq(triageJobs.submitTokenHash, hashSecret(input.secret)),
        eq(triageJobs.status, "claimed"),
        gt(triageJobs.leaseExpiresAt, now),
      ),
    );
  return rows[0] ?? null;
}
