import {
  HUMAN_TRIAGE_LABEL,
  type HumanTriageReason,
  type TriageLabel,
  type TriageOutcome,
  type TriagePriority,
  type TriageResult,
} from "@pw-support/contracts";

export const QUOTE_MAX_CHARS = 4_000;
export const TITLE_MAX_CHARS = 120;
const FILENAME_MAX_CHARS = 100;
const ZERO_WIDTH_SPACE = "​";

export const LABEL_NAMES: Record<TriageLabel, string> = {
  bug: "Bug",
  feature: "Feature",
  question: "Question",
  ux: "UX",
  performance: "Performance",
  data: "Data",
  integration: "Integration",
  security: "Security",
  "needs-info": "Needs info",
};

export const PRIORITY_VALUES: Record<TriagePriority, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
  none: 0,
};

export function requestMarker(requestId: string): string {
  return `Support request ID: ${requestId}`;
}

function controlFree(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (
        code === 10 ||
        code === 9 ||
        (code >= 32 && code !== 0x2028 && code !== 0x2029)
      );
    })
    .join("");
}

export function stripMarkup(value: string): string {
  return controlFree(value.replace(/\r\n?/g, "\n"))
    .replace(/<[^>]*>/g, "")
    .replace(/!\[/g, "[")
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`);
}

export function quoteCustomerText(text: string): string {
  const cleaned = stripMarkup(text).trim();
  const capped =
    cleaned.length > QUOTE_MAX_CHARS
      ? `${cleaned.slice(0, QUOTE_MAX_CHARS)}\n[text cut at ${QUOTE_MAX_CHARS} characters]`
      : cleaned;
  return capped
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

export function safeFilename(filename: string): string {
  const cleaned = stripMarkup(filename)
    .replace(/[`[\]()<>\n\t]/g, "_")
    .trim()
    .slice(0, FILENAME_MAX_CHARS);
  return cleaned === "" ? "file" : cleaned;
}

function oneLine(value: string): string {
  return stripMarkup(value).replace(/\s+/g, " ").trim();
}

export interface TicketInput {
  requestId: string;
  result: TriageResult;
  outcome: TriageOutcome;
  humanTriageReason?: HumanTriageReason;
  customerText: string;
  attachmentNames: string[];
}

export interface TicketDraft {
  title: string;
  description: string;
  priority: number;
  labelNames: string[];
}

export function buildTicket(input: TicketInput): TicketDraft {
  const { result } = input;
  const human = input.outcome === "human_triage";
  const title =
    oneLine(result.title).slice(0, TITLE_MAX_CHARS) || "Support request";
  const sections: string[] = [stripMarkup(result.summary).trim()];
  if (human && input.humanTriageReason) {
    sections.push(`Reason: ${input.humanTriageReason}`);
  } else {
    sections.push(
      `Category: ${result.category}. Priority: ${result.priority}.`,
    );
  }
  sections.push(
    `## Customer message\n${quoteCustomerText(input.customerText)}`,
  );
  if (input.attachmentNames.length > 0) {
    sections.push(
      `## Attachments\n${input.attachmentNames.map((name) => `- \`${safeFilename(name)}\``).join("\n")}`,
    );
  }
  sections.push(requestMarker(input.requestId));
  const labelNames = result.labels.map((label) => LABEL_NAMES[label]);
  if (human) labelNames.push(HUMAN_TRIAGE_LABEL);
  return {
    title,
    description: sections.join("\n\n"),
    priority: PRIORITY_VALUES[result.priority],
    labelNames,
  };
}
