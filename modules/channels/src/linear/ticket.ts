import {
  HUMAN_TRIAGE_LABEL,
  type HumanTriageReason,
  type TriageLabel,
  type TriageOutcome,
  type TriagePriority,
  type TriageResult,
} from "@pw-support/contracts";
import { FOLLOW_UP_HEADER_PREFIX } from "../reply/marker";

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

function defangLinks(value: string): string {
  return value
    .replace(/:\/\//g, `:${ZERO_WIDTH_SPACE}//`)
    .replace(/\bwww\./gi, `www${ZERO_WIDTH_SPACE}.`);
}

const MARKDOWN_CONTROL = /[\\[\]()#*_~|<>`!&]/g;

const TITLE_STRIPPED = /[\\[\]#*_~|<>`!&]/g;

function plainTitle(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(TITLE_STRIPPED, "")
    .replace(/(support\s+request\s+id)\s*:/gi, `$1${ZERO_WIDTH_SPACE}:`)
    .trim();
}

function inertLine(line: string): string {
  return line
    .trim()
    .replace(MARKDOWN_CONTROL, "\\$&")
    .replace(/^([-+=])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/(support\s+request\s+id)\s*:/gi, `$1${ZERO_WIDTH_SPACE}:`);
}

export function inertText(value: string, singleLine = false): string {
  const cleaned = defangLinks(stripMarkup(value));
  if (singleLine) return plainTitle(cleaned);
  return cleaned.split("\n").map(inertLine).join("\n").trim();
}

export function quoteCustomerText(text: string): string {
  const cleaned = defangLinks(stripMarkup(text))
    .replace(/[[\]&]/g, "\\$&")
    .trim();
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

export function messageMarker(messageId: string): string {
  return `Support message ID: ${messageId}`;
}

export interface FollowUpInput {
  messageId: string;
  originChannel: string;
  text: string;
  attachmentNames: string[];
}

export function buildFollowUpComment(input: FollowUpInput): string {
  const sections = [
    `${FOLLOW_UP_HEADER_PREFIX} ${safeFilename(input.originChannel)}`,
    quoteCustomerText(input.text),
  ];
  if (input.attachmentNames.length > 0) {
    sections.push(
      `Attachments:\n${input.attachmentNames
        .map((name) => `- \`${safeFilename(name)}\``)
        .join("\n")}`,
    );
  }
  sections.push(messageMarker(input.messageId));
  return sections.join("\n\n");
}

export interface TicketInput {
  requestId: string;
  result: TriageResult;
  outcome: TriageOutcome;
  humanTriageReason?: HumanTriageReason;
  customerText: string;
  attachments: TicketAttachment[];
}

export interface TicketAttachment {
  filename: string;
  notAnalyzed?: boolean;
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
    inertText(result.title.slice(0, TITLE_MAX_CHARS), true) ||
    "Support request";
  const sections: string[] = [inertText(result.summary)];
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
  if (input.attachments.length > 0) {
    sections.push(
      `## Attachments\n${input.attachments
        .map(
          (file) =>
            `- \`${safeFilename(file.filename)}\`${file.notAnalyzed ? " (not analyzed)" : ""}`,
        )
        .join("\n")}`,
    );
  }
  sections.push(requestMarker(input.requestId));
  const labelNames = result.labels.map((label) => LABEL_NAMES[label]);
  if (human || result.needs_human) labelNames.push(HUMAN_TRIAGE_LABEL);
  return {
    title,
    description: sections.join("\n\n"),
    priority: PRIORITY_VALUES[result.priority],
    labelNames,
  };
}
