import { readObjectBytes, type ObjectStorage } from "@pw-support/api";
import type { HumanTriageReason } from "@pw-support/contracts";
import {
  claimTriageJob,
  loadTriageContext,
  recordAgentSession,
  recordJudgments,
  releaseTriageJob,
  submitHumanTriage,
  submitTriageResult,
  type SupportDb,
  type TriageJob,
} from "@pw-support/db";
import type { AgentInput, AgentRunner } from "./agent-runner";
import type { TriageConfig } from "./config";
import { type AttachmentInput, extractAttachments } from "./extract";
import { type FilterSubject, runInjectionFilter } from "./filter";
import type { JevClient } from "./jev";
import { parseAgentOutput } from "./parse";

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
  | { status: "completed"; outcome: "agent" | "human_triage"; reason?: HumanTriageReason }
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

export async function processClaimedJob(
  deps: ProcessDeps,
  job: TriageJob,
): Promise<ProcessOutcome> {
  const token = job.claimToken as string;
  const log = logOf(deps);
  try {
    if (job.attempts > deps.config.timing.maxAttempts) {
      return await complete(deps, job, "attempts_exhausted");
    }
    const context = await loadTriageContext(deps.db, job.requestId);
    if (!context) throw new Error("request missing for job");
    const inputs: AttachmentInput[] = [];
    for (const attachment of context.attachments) {
      inputs.push({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        bytes: await readObjectBytes(deps.storage, attachment.storageKey),
      });
    }
    const items = await extractAttachments(inputs, deps.config.extract);
    const requestText = context.messages.map((m) => m.body).join("\n\n");

    const subjects: FilterSubject[] = [
      { subject: "message", text: requestText },
    ];
    for (const item of items) {
      if (item.kind === "document") {
        subjects.push({ subject: `attachment:${item.id}`, text: item.text });
      } else if (
        item.kind === "image" &&
        deps.config.jev.judgeImages &&
        (item.format === "png" || item.format === "jpeg")
      ) {
        subjects.push({
          subject: `image:${item.id}`,
          image: { format: item.format, base64: item.base64 },
        });
      }
    }
    const verdict = await runInjectionFilter(subjects, {
      jev: deps.jev,
      threshold: deps.config.jev.threshold,
      chunkChars: deps.config.jev.chunkChars,
      requestId: job.requestId,
    });
    await recordJudgments(deps.db, verdict.judgments);
    if (verdict.unavailable) {
      log("jev unavailable", { jobId: job.id, error: verdict.error });
      return await complete(deps, job, "filter_unavailable");
    }
    if (verdict.flagged) return await complete(deps, job, "injection_flagged");

    const agentInput: AgentInput = {
      requestText,
      images: items.flatMap((item) =>
        item.kind === "image"
          ? [
              {
                filename: item.filename,
                mediaType: item.mediaType,
                base64: item.base64,
              },
            ]
          : [],
      ),
      documents: items.flatMap((item) =>
        item.kind === "document"
          ? [
              {
                filename: item.filename,
                text: item.text,
                truncated: item.truncated,
              },
            ]
          : [],
      ),
      skipped: items.flatMap((item) =>
        item.kind === "skipped"
          ? [{ filename: item.filename, reason: item.reason }]
          : [],
      ),
    };

    let run: Awaited<ReturnType<AgentRunner["run"]>>;
    try {
      run = await deps.agent.run(agentInput, {
        onSession: (sessionId) =>
          recordAgentSession(deps.db, {
            jobId: job.id,
            claimToken: token,
            sessionId,
          }),
      });
    } catch (error) {
      log("agent failed", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return await complete(deps, job, "agent_error");
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
    return await complete(
      deps,
      reclaim.job,
      "agent_output_invalid",
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log("processing failed", { jobId: job.id, error: reason });
    await releaseTriageJob(deps.db, {
      jobId: job.id,
      claimToken: token,
      reason: "processing_failed",
      now: deps.now,
    }).catch(() => {});
    return { status: "released", reason: "processing_failed" };
  }
}
