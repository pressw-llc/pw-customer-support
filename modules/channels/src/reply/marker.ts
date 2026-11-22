import {
  REPLY_HOLD_TTL_SECONDS,
  type ReplyHoldReason,
  WORDING_HOLD_BELOW,
} from "@pw-support/contracts";
import { plainStaffText } from "./plain-text";

export const EXTERNAL_MARKER = "@external";
export const CONFIRM_COMMAND = "@confirm";
export const HOLD_WARNING_PREFIX = "Reply held, not sent to the customer.";
export const HOLD_CANCELLED_PREFIX = "Reply hold cancelled.";
export const FOLLOW_UP_HEADER_PREFIX = "Customer follow-up via";

export type StaffCommentClass =
  | { kind: "internal" }
  | { kind: "external"; text: string };

const ASCII_SPACE = new Set([" ", "\t", "\r", "\n"]);

function dropsFromReplyText(code: number): boolean {
  return (
    (code < 32 && code !== 10 && code !== 9) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

export function plainReplyText(value: string): string {
  return Array.from(value.replace(/\r\n?/g, "\n"))
    .filter((char) => !dropsFromReplyText(char.codePointAt(0) ?? 0))
    .join("")
    .trim();
}

export function classifyStaffComment(body: string): StaffCommentClass {
  let start = 0;
  while (start < body.length && ASCII_SPACE.has(body.charAt(start))) start++;
  if (!body.startsWith(EXTERNAL_MARKER, start)) return { kind: "internal" };
  const end = start + EXTERNAL_MARKER.length;
  if (end < body.length && !ASCII_SPACE.has(body.charAt(end))) {
    return { kind: "internal" };
  }
  const text = plainReplyText(plainStaffText(body.slice(end)));
  return text === "" ? { kind: "internal" } : { kind: "external", text };
}

export function isConfirmComment(body: string): boolean {
  let start = 0;
  let end = body.length;
  while (start < end && ASCII_SPACE.has(body.charAt(start))) start++;
  while (end > start && ASCII_SPACE.has(body.charAt(end - 1))) end--;
  return body.slice(start, end) === CONFIRM_COMMAND;
}

export function isSystemComment(body: string): boolean {
  return (
    body.startsWith(FOLLOW_UP_HEADER_PREFIX) ||
    body.startsWith(HOLD_WARNING_PREFIX) ||
    body.startsWith(HOLD_CANCELLED_PREFIX)
  );
}

export function replyMarker(replyId: string): string {
  return `Support reply ID: ${replyId}`;
}

export function buildHoldWarning(input: {
  reason: ReplyHoldReason;
  score: number;
  maxChars: number;
  replyId: string;
}): string {
  const why =
    input.reason === "wording_low"
      ? `The wording check scored it ${input.score.toFixed(1)} out of 5. A reply needs ${WORDING_HOLD_BELOW.toFixed(1)} or more to send.`
      : input.reason === "too_long"
        ? `The reply is longer than ${input.maxChars} characters.`
        : "The wording check was unavailable.";
  const hours = Math.round(REPLY_HOLD_TTL_SECONDS / 3600);
  return `${HOLD_WARNING_PREFIX} ${why} Reply \`${CONFIRM_COMMAND}\` in this thread to send it as written. Editing or deleting the comment cancels the hold, so post a new \`${EXTERNAL_MARKER}\` comment instead. The hold expires after ${hours} hours.\n\n${replyMarker(input.replyId)}`;
}

export function cancelMarker(replyId: string): string {
  return `Support reply cancel ID: ${replyId}`;
}

export function buildCancelNotice(replyId: string): string {
  return `${HOLD_CANCELLED_PREFIX} The comment was edited or deleted, so the held reply will not send. Post a new \`${EXTERNAL_MARKER}\` comment to reply to the customer.\n\n${cancelMarker(replyId)}`;
}
