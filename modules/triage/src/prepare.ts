import { type ObjectStorage, readObjectBytes } from "@pw-support/api";
import type { HumanTriageReason } from "@pw-support/contracts";
import {
  type JudgmentInput,
  loadTriageContext,
  recordJudgments,
  type SupportDb,
  type TriageJob,
} from "@pw-support/db";
import type { AgentInput } from "./agent-runner";
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

export const WITHHELD_IMAGE_REASON = "image_not_analyzed";

export interface PrepareDeps {
  db: SupportDb;
  storage: ObjectStorage;
  jev: JevClient | null;
  config: TriageConfig;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export type Prepared =
  | { status: "ready"; agentInput: AgentInput }
  | { status: "human_triage"; reason: HumanTriageReason }
  | { status: "aborted" };

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

export async function prepareAgentInput(
  deps: PrepareDeps,
  job: TriageJob,
  signal: AbortSignal = new AbortController().signal,
): Promise<Prepared> {
  const { threshold } = deps.config.jev;
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
  if (signal.aborted) return { status: "aborted" };
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
  if (signal.aborted) return { status: "aborted" };
  if (verdict.unavailable) {
    deps.log?.("jev unavailable", { jobId: job.id, error: verdict.error });
    return { status: "human_triage", reason: "filter_unavailable" };
  }
  if (verdict.flagged) {
    return { status: "human_triage", reason: "injection_flagged" };
  }
  return {
    status: "ready",
    agentInput: buildAgentInput(
      requestText,
      items,
      judgedImageIds(verdict.judgments),
    ),
  };
}
