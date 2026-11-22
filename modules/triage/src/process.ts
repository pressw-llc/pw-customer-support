import type { ObjectStorage } from "@pw-support/api";
import type { HumanTriageReason } from "@pw-support/contracts";
import {
  claimTriageJob,
  recordAgentSession,
  releaseTriageJob,
  type SupportDb,
  submitHumanTriage,
  submitTriageResult,
  type TriageJob,
} from "@pw-support/db";
import {
  AgentAbortedError,
  AgentDefinitionUnsafeError,
  type AgentRunner,
} from "./agent-runner";
import type { TriageConfig } from "./config";
import type { JevClient } from "./jev";
import { parseAgentOutput } from "./parse";
import { prepareAgentInput } from "./prepare";

export interface ProcessDeps {
  db: SupportDb;
  storage: ObjectStorage;
  jev: JevClient | null;
  agent: AgentRunner;
  config: TriageConfig;
  claimant: string;
  now?: () => Date;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export type ProcessOutcome =
  | {
      status: "completed";
      outcome: "agent" | "human_triage";
      reason?: HumanTriageReason;
    }
  | { status: "released"; reason: string };

function logOf(deps: ProcessDeps) {
  return deps.log ?? (() => {});
}

async function complete(
  deps: ProcessDeps,
  job: TriageJob,
  reason: HumanTriageReason,
): Promise<ProcessOutcome> {
  const result = await submitHumanTriage(deps.db, {
    jobId: job.id,
    claimToken: job.claimToken as string,
    reason,
    now: deps.now,
  });
  if (!result.ok) return { status: "released", reason: "stale_claim" };
  logOf(deps)("human triage", { jobId: job.id, reason });
  return { status: "completed", outcome: "human_triage", reason };
}

const LEASE_LOST: ProcessOutcome = { status: "released", reason: "lease_lost" };

export async function processClaimedJob(
  deps: ProcessDeps,
  job: TriageJob,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProcessOutcome> {
  const token = job.claimToken as string;
  const log = logOf(deps);
  try {
    if (job.attempts > deps.config.timing.maxAttempts) {
      return await complete(deps, job, "attempts_exhausted");
    }
    const prepared = await prepareAgentInput(deps, job, signal);
    if (prepared.status === "aborted") return LEASE_LOST;
    if (prepared.status === "human_triage") {
      return await complete(deps, job, prepared.reason);
    }

    let run: Awaited<ReturnType<AgentRunner["run"]>>;
    try {
      run = await deps.agent.run(prepared.agentInput, {
        signal,
        onSession: (sessionId) =>
          recordAgentSession(deps.db, {
            jobId: job.id,
            claimToken: token,
            sessionId,
          }),
      });
    } catch (error) {
      if (error instanceof AgentAbortedError || signal.aborted) {
        return LEASE_LOST;
      }
      const unsafe = error instanceof AgentDefinitionUnsafeError;
      log("agent failed", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return await complete(
        deps,
        job,
        unsafe ? "agent_definition_unsafe" : "agent_error",
      );
    }

    const submitted = await submitTriageResult(deps.db, {
      jobId: job.id,
      claimToken: token,
      payload: parseAgentOutput(run.textOutput),
      now: deps.now,
    });
    if (submitted.ok) {
      return { status: "completed", outcome: "agent" };
    }
    if (submitted.reason === "stale_claim") {
      return { status: "released", reason: "stale_claim" };
    }
    const reclaim = await claimTriageJob(deps.db, {
      jobId: job.id,
      kind: "cloud",
      claimant: deps.claimant,
      now: deps.now,
      timing: deps.config.timing,
    });
    if (!reclaim.won) return { status: "released", reason: "reclaim_lost" };
    return await complete(deps, reclaim.job, "agent_output_invalid");
  } catch (error) {
    if (signal.aborted) return LEASE_LOST;
    const reason = error instanceof Error ? error.message : String(error);
    log("processing failed", { jobId: job.id, error: reason });
    try {
      await releaseTriageJob(deps.db, {
        jobId: job.id,
        claimToken: token,
        reason: "processing_failed",
        now: deps.now,
      });
    } catch (releaseError) {
      log("release failed", {
        jobId: job.id,
        error:
          releaseError instanceof Error
            ? releaseError.message
            : String(releaseError),
      });
      throw releaseError;
    }
    return { status: "released", reason: "processing_failed" };
  }
}
