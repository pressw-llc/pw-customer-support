import type { LaptopBackend } from "@pw-support/api";
import type {
  HumanTriageReason,
  LaptopPrepared,
  WakeSender,
} from "@pw-support/contracts";
import {
  releaseTriageJob,
  submitHumanTriage,
  type TriageJob,
} from "@pw-support/db";
import { buildUserContent } from "./agent-runner";
import { type PrepareDeps, prepareAgentInput } from "./prepare";
import { submitResult } from "./submit";

export interface LaptopBackendDeps extends PrepareDeps {
  wake: WakeSender;
  now?: () => Date;
}

export function createLaptopBackend(deps: LaptopBackendDeps): LaptopBackend {
  async function finish(
    job: TriageJob,
    reason: HumanTriageReason,
  ): Promise<LaptopPrepared> {
    const result = await submitHumanTriage(deps.db, {
      jobId: job.id,
      claimToken: job.claimToken as string,
      reason,
      now: deps.now,
    });
    if (!result.ok) return { status: "nothing_to_do", reason: "lease_lost" };
    deps.log?.("human triage", { jobId: job.id, reason });
    return { status: "nothing_to_do", reason };
  }

  return {
    submit: (input) => submitResult({ db: deps.db, wake: deps.wake }, input),
    async prepare(job) {
      try {
        if (job.attempts > deps.config.timing.maxAttempts) {
          return await finish(job, "attempts_exhausted");
        }
        const prepared = await prepareAgentInput(deps, job);
        if (prepared.status === "human_triage") {
          return await finish(job, prepared.reason);
        }
        if (prepared.status === "aborted") throw new Error("aborted");
        return {
          status: "ready",
          content: buildUserContent(prepared.agentInput),
        };
      } catch (error) {
        deps.log?.("laptop preparation failed", {
          jobId: job.id,
          error: error instanceof Error ? error.name : "unknown",
        });
        await releaseTriageJob(deps.db, {
          jobId: job.id,
          claimToken: job.claimToken as string,
          reason: "processing_failed",
          now: deps.now,
        });
        return { status: "nothing_to_do", reason: "preparation_failed" };
      }
    },
  };
}
