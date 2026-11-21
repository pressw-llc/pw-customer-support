import { MAX_MESSAGE_CHARS } from "@pw-support/contracts";

export interface MessageVerdict {
  sanitized: string;
  flagged: boolean;
  reasons: string[];
}

const BLOCK_ELEMENTS = /<(script|style)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const TAGS = /<\/?[a-zA-Z!?][^>]*>/g;
const UNTERMINATED_TAG = /<\/?[a-zA-Z!?][^>]*$/;
const MAX_PASSES = 5;

const KEPT_CONTROL = new Set([0x09, 0x0a, 0x0d]);

function dropControlChars(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return KEPT_CONTROL.has(code) || (code >= 0x20 && code !== 0x7f);
    })
    .join("");
}

export function stripMarkup(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = dropControlChars(
      current
        .replace(COMMENTS, "")
        .replace(BLOCK_ELEMENTS, "")
        .replace(TAGS, "")
        .replace(UNTERMINATED_TAG, ""),
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

export function checkMessage(raw: string): MessageVerdict {
  const stripped = stripMarkup(raw);
  const reasons: string[] = [];
  if (stripped !== raw) reasons.push("markup");
  if (stripped.length > MAX_MESSAGE_CHARS) reasons.push("too_long");
  return {
    sanitized: stripped.slice(0, MAX_MESSAGE_CHARS),
    flagged: reasons.length > 0,
    reasons,
  };
}
