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

export async function handleWake(
  deps: WorkerDeps,
  jobId: string,
): Promise<WakeOutcome> {
  const timing = deps.config.timing;
  const job = await getTriageJob(deps.db, jobId);
  if (!job) return { action: "dropped" };
  const availability = cloudAvailability(job, clockOf(deps), timing);
  if (availability.state === "completed") return { action: "dropped" };
  if (availability.state === "leased" || availability.state === "waiting") {
    await deps.wake.send(jobId, availability.waitSeconds);
    return { action: "deferred", delaySeconds: availability.waitSeconds };
  }
  const claim = await claimTriageJob(deps.db, {
    jobId,
    kind: "cloud",
    claimant: deps.claimant,
    now: deps.now,
    timing,
  });
  if (!claim.won) return { action: "lost" };
  const token = claim.job.claimToken as string;
  const heartbeat = setInterval(
    () => {
      extendTriageLease(deps.db, {
        jobId,
        claimToken: token,
        now: deps.now,
        timing,
      }).catch(() => {});
    },
    Math.max(1000, (timing.leaseSeconds * 1000) / 3),
  );
  try {
    return {
      action: "processed",
      result: await processClaimedJob(deps, claim.job),
    };
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
): Promise<void> {
  const log = deps.log ?? (() => {});
  return new Promise((resolve) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await sweepOnce(deps);
      } catch (error) {
        log("sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = setInterval(tick, deps.config.sweepIntervalMs);
    signal.addEventListener("abort", () => {
      clearInterval(timer);
      resolve();
    });
  });
}
