import type { WakeSender } from "@pw-support/contracts";
import {
  claimTriageJob,
  cloudAvailability,
  extendTriageLease,
  getTriageJob,
  listCloudEligibleJobs,
} from "@pw-support/db";
import {
  type ProcessDeps,
  type ProcessOutcome,
  processClaimedJob,
} from "./process";

export interface WorkerDeps extends ProcessDeps {
  wake: WakeSender;
}

export type WakeOutcome =
  | { action: "dropped" }
  | { action: "deferred"; delaySeconds: number }
  | { action: "lost" }
  | { action: "processed"; result: ProcessOutcome };

function clockOf(deps: WorkerDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

export const RETRY_BASE_SECONDS = 5;
export const RETRY_MAX_SECONDS = 60;

export function retryDelaySeconds(attempts: number): number {
  return Math.min(
    RETRY_MAX_SECONDS,
    RETRY_BASE_SECONDS * 2 ** Math.max(0, attempts - 1),
  );
}

async function deferral(deps: WorkerDeps, jobId: string): Promise<WakeOutcome> {
  const job = await getTriageJob(deps.db, jobId);
  if (!job) return { action: "dropped" };
  const availability = cloudAvailability(
    job,
    clockOf(deps),
    deps.config.timing,
  );
  if (availability.state === "leased" || availability.state === "waiting") {
    await deps.wake.send(jobId, availability.waitSeconds);
    return { action: "deferred", delaySeconds: availability.waitSeconds };
  }
  return availability.state === "completed"
    ? { action: "dropped" }
    : { action: "lost" };
}

export async function handleWake(
  deps: WorkerDeps,
  jobId: string,
): Promise<WakeOutcome> {
  const timing = deps.config.timing;
  const claim = await claimTriageJob(deps.db, {
    jobId,
    kind: "cloud",
    claimant: deps.claimant,
    now: deps.now,
    timing,
  });
  if (!claim.won) return deferral(deps, jobId);
  const token = claim.job.claimToken as string;
  const ownership = new AbortController();
  const heartbeat = setInterval(
    async () => {
      try {
        const held = await extendTriageLease(deps.db, {
          jobId,
          claimToken: token,
          now: deps.now,
          timing,
        });
        if (!held) {
          deps.log?.("lease lost", { jobId });
          ownership.abort();
        }
      } catch (error) {
        deps.log?.("lease renewal failed", {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    Math.max(1000, (timing.leaseSeconds * 1000) / 3),
  );
  try {
    const result = await processClaimedJob(deps, claim.job, ownership.signal);
    if (result.status === "released" && result.reason === "processing_failed") {
      await deps.wake.send(jobId, retryDelaySeconds(claim.job.attempts));
    }
    return { action: "processed", result };
  } finally {
    clearInterval(heartbeat);
  }
}

export async function sweepOnce(deps: WorkerDeps): Promise<WakeOutcome[]> {
  const jobs = await listCloudEligibleJobs(deps.db, {
    now: deps.now,
    timing: deps.config.timing,
  });
  const outcomes: WakeOutcome[] = [];
  for (const job of jobs) {
    outcomes.push(await handleWake(deps, job.id));
  }
  return outcomes;
}

export function startSweeper(
  deps: WorkerDeps,
  signal: AbortSignal,
  sweep: (deps: WorkerDeps) => Promise<unknown> = sweepOnce,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let inflight: Promise<unknown> | undefined;
    const tick = () => {
      if (inflight) return;
      inflight = sweep(deps)
        .catch((error) => {
          deps.log?.("sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          inflight = undefined;
        });
    };
    tick();
    const timer = setInterval(tick, deps.config.sweepIntervalMs);
    signal.addEventListener("abort", () => {
      clearInterval(timer);
      void Promise.allSettled([inflight]).then(() => resolve());
    });
  });
}
