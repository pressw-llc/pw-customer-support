import { type ObjectStorage, readObjectBytes } from "@pw-support/api";
import type { HumanTriageReason } from "@pw-support/contracts";
import {
  claimTriageJob,
  type JudgmentInput,
  loadTriageContext,
  recordAgentSession,
  recordJudgments,
  releaseTriageJob,
  type SupportDb,
  submitHumanTriage,
  submitTriageResult,
  type TriageJob,
} from "@pw-support/db";
import {
  AgentAbortedError,
  AgentDefinitionUnsafeError,
  type AgentInput,
  type AgentRunner,
} from "./agent-runner";
import type { TriageConfig } from "./config";
import {
  type AttachmentInput,
  type ExtractedItem,
  extractAttachments,
} from "./extract";
import {
  type FilterSubject,
  INJECTION_KIND,
  runInjectionFilter,
} from "./filter";
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
  | {
      status: "completed";
      outcome: "agent" | "human_triage";
      reason?: HumanTriageReason;
    }
  | { status: "released"; reason: string };

export const WITHHELD_IMAGE_REASON = "image_not_analyzed";

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

function judgedMessage(requestText: string, filenames: string[]): string {
  return filenames.length === 0
    ? requestText
    : `${requestText}\n\nAttachment filenames:\n${filenames.join("\n")}`;
}

function withheldJudgment(
  requestId: string,
  imageId: string,
  threshold: number,
  reason: string,
): JudgmentInput {
  return {
    requestId,
    kind: INJECTION_KIND,
    subject: `image:${imageId}`,
    score: 0,
    threshold,
    flagged: false,
    raw: { skipped: true, reason },
  };
}

function judgedImageIds(judgments: JudgmentInput[]): Set<string> {
  return new Set(
    judgments
      .filter(
        (judgment) =>
          judgment.subject.startsWith("image:") &&
          !judgment.flagged &&
          judgment.raw.skipped !== true,
      )
      .map((judgment) => judgment.subject.slice("image:".length)),
  );
}

function buildAgentInput(
  requestText: string,
  items: ExtractedItem[],
  judged: Set<string>,
): AgentInput {
  const images = items.flatMap((item) =>
    item.kind === "image" && judged.has(item.id)
      ? [
          {
            filename: item.filename,
            mediaType: item.mediaType,
            base64: item.base64,
          },
        ]
      : [],
  );
  const documents = items.flatMap((item) =>
    item.kind === "document"
      ? [
          {
            filename: item.filename,
            text: item.text,
            truncated: item.truncated,
          },
        ]
      : [],
  );
  const skipped = items.flatMap((item) => {
    if (item.kind === "skipped") {
      return [{ filename: item.filename, reason: item.reason }];
    }
    return item.kind === "image" && !judged.has(item.id)
      ? [{ filename: item.filename, reason: WITHHELD_IMAGE_REASON }]
      : [];
  });
  return { requestText, images, documents, skipped };
}

const LEASE_LOST: ProcessOutcome = { status: "released", reason: "lease_lost" };

export async function processClaimedJob(
  deps: ProcessDeps,
  job: TriageJob,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProcessOutcome> {
  const token = job.claimToken as string;
  const log = logOf(deps);
  const { threshold } = deps.config.jev;
  try {
    if (job.attempts > deps.config.timing.maxAttempts) {
      return await complete(deps, job, "attempts_exhausted");
    }
    const context = await loadTriageContext(deps.db, job.requestId);
    if (!context) throw new Error("request missing for job");
    const inputs: AttachmentInput[] = context.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      load: () => readObjectBytes(deps.storage, attachment.storageKey),
    }));
    const items = await extractAttachments(inputs, deps.config.extract);
    if (signal.aborted) return LEASE_LOST;
    const requestText = context.messages.map((m) => m.body).join("\n\n");

    const subjects: FilterSubject[] = [
      {
        subject: "message",
        text: judgedMessage(
          requestText,
          context.attachments.map((attachment) => attachment.filename),
        ),
      },
    ];
    const withheld: JudgmentInput[] = [];
    for (const item of items) {
      if (item.kind === "document") {
        subjects.push({ subject: `attachment:${item.id}`, text: item.text });
      } else if (item.kind === "image") {
        if (!deps.config.jev.judgeImages) {
          withheld.push(
            withheldJudgment(
              job.requestId,
              item.id,
              threshold,
              "image_judging_disabled",
            ),
          );
        } else if (item.format === "png" || item.format === "jpeg") {
          subjects.push({
            subject: `image:${item.id}`,
            image: { format: item.format, base64: item.base64 },
          });
        } else {
          withheld.push(
            withheldJudgment(
              job.requestId,
              item.id,
              threshold,
              "image_format_not_judgeable",
            ),
          );
        }
      }
    }
    const verdict = await runInjectionFilter(subjects, {
      jev: deps.jev,
      threshold,
      chunkChars: deps.config.jev.chunkChars,
      requestId: job.requestId,
    });
    await recordJudgments(deps.db, [...verdict.judgments, ...withheld]);
    if (signal.aborted) return LEASE_LOST;
    if (verdict.unavailable) {
      log("jev unavailable", { jobId: job.id, error: verdict.error });
      return await complete(deps, job, "filter_unavailable");
    }
    if (verdict.flagged) return await complete(deps, job, "injection_flagged");

    const agentInput = buildAgentInput(
      requestText,
      items,
      judgedImageIds(verdict.judgments),
    );

    let run: Awaited<ReturnType<AgentRunner["run"]>>;
    try {
      run = await deps.agent.run(agentInput, {
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
