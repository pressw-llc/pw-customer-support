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

function cleanCustomerText(text: string): string {
  return defangLinks(stripMarkup(text))
    .replace(/[[\]&]/g, "\\$&")
    .trim();
}

function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

export function quoteCustomerText(text: string): string {
  const cleaned = cleanCustomerText(text);
  const capped =
    cleaned.length > QUOTE_MAX_CHARS
      ? `${cleaned.slice(0, QUOTE_MAX_CHARS)}\n[text cut at ${QUOTE_MAX_CHARS} characters]`
      : cleaned;
  return quoteLines(capped);
}

export interface TicketMessage {
  id: string;
  text: string;
  ready: boolean;
}

interface QuotedMessages {
  quote: string;
  includedIds: Set<string>;
}

function quoteMessages(messages: TicketMessage[]): QuotedMessages {
  const parts: string[] = [];
  const includedIds = new Set<string>();
  let used = 0;
  let omitted = false;
  for (const message of messages) {
    if (!message.ready) continue;
    const cleaned = cleanCustomerText(message.text);
    const cost = (parts.length > 0 ? 2 : 0) + cleaned.length;
    if (used + cost > QUOTE_MAX_CHARS) {
      if (parts.length === 0) {
        parts.push(
          `${cleaned.slice(0, QUOTE_MAX_CHARS)}\n[text cut at ${QUOTE_MAX_CHARS} characters]`,
        );
      }
      omitted = parts.length > 0 && includedIds.size > 0;
      break;
    }
    parts.push(cleaned);
    includedIds.add(message.id);
    used += cost;
  }
  if (omitted) parts.push("[further messages follow as comments]");
  return { quote: quoteLines(parts.join("\n\n")), includedIds };
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

export function attachmentsMarker(attachmentId: string): string {
  return `Support attachment ID: ${attachmentId}`;
}

export function buildLateAttachmentsComment(input: {
  originChannel: string;
  attachmentNames: string[];
  marker: string;
}): string {
  return [
    `${FOLLOW_UP_HEADER_PREFIX} ${safeFilename(input.originChannel)}`,
    `Attachments added later:\n${input.attachmentNames
      .map((name) => `- \`${safeFilename(name)}\``)
      .join("\n")}`,
    input.marker,
  ].join("\n\n");
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
  messages: TicketMessage[];
  attachments: TicketAttachment[];
}

export interface TicketAttachment {
  id: string;
  messageId: string;
  filename: string;
  notAnalyzed?: boolean;
}

export interface TicketDraft {
  title: string;
  description: string;
  priority: number;
  labelNames: string[];
  deliveredMessageIds: string[];
  deliveredAttachmentIds: string[];
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
  const quoted = quoteMessages(input.messages);
  sections.push(`## Customer message\n${quoted.quote}`);
  const listed = input.attachments.filter((file) =>
    quoted.includedIds.has(file.messageId),
  );
  if (listed.length > 0) {
    sections.push(
      `## Attachments\n${listed
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
    deliveredMessageIds: [...quoted.includedIds],
    deliveredAttachmentIds: listed.map((file) => file.id),
  };
}
