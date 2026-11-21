import { MAX_MESSAGE_CHARS } from "@pw-support/contracts";

export interface MessageVerdict {
  sanitized: string;
  flagged: boolean;
  reasons: string[];
}

export const MAX_STORED_MESSAGE_CHARS = MAX_MESSAGE_CHARS * 4;
export const MAX_TEXT_FIELD_BYTES = 1024 * 1024;

const MAX_PASSES = 5;
const BLOCK_NAMES = ["script", "style"] as const;
const KEPT_CONTROL = new Set([0x09, 0x0a, 0x0d]);
const WHITESPACE = /\s/;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
  return text.slice(0, end);
}

export function capInboundText(text: string): {
  text: string;
  truncated: boolean;
} {
  const truncated = text.length > MAX_STORED_MESSAGE_CHARS;
  return {
    text: truncated ? clip(text, MAX_STORED_MESSAGE_CHARS) : text,
    truncated,
  };
}

function dropControlChars(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return KEPT_CONTROL.has(code) || (code >= 0x20 && code !== 0x7f);
    })
    .join("");
}

function isWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

function isTagStart(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x21 ||
    code === 0x3f
  );
}

function startsWithAt(text: string, index: number, word: string): boolean {
  if (index + word.length > text.length) return false;
  for (let offset = 0; offset < word.length; offset++) {
    const code = text.charCodeAt(index + offset);
    const lower = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    if (lower !== word.charCodeAt(offset)) return false;
  }
  return true;
}

function stripComments(text: string): string {
  const out: string[] = [];
  let cursor = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf("<!--", from);
    if (open === -1) break;
    const close = text.indexOf("-->", open + 4);
    if (close === -1) break;
    out.push(text.slice(cursor, open));
    cursor = close + 3;
    from = cursor;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

function findClosingTag(text: string, from: number, name: string): number {
  let search = from;
  for (;;) {
    const open = text.indexOf("</", search);
    if (open === -1) return -1;
    if (startsWithAt(text, open + 2, name)) {
      let cursor = open + 2 + name.length;
      while (cursor < text.length && WHITESPACE.test(text[cursor] ?? "")) {
        cursor++;
      }
      if (text[cursor] === ">") return cursor + 1;
    }
    search = open + 2;
  }
}

function blockNameAt(
  text: string,
  index: number,
  exhausted: Set<string>,
): string | null {
  for (const name of BLOCK_NAMES) {
    if (exhausted.has(name)) continue;
    const end = index + 1 + name.length;
    if (
      startsWithAt(text, index + 1, name) &&
      !isWordChar(text.charCodeAt(end))
    ) {
      return name;
    }
  }
  return null;
}

function stripBlocks(text: string): string {
  const out: string[] = [];
  const exhausted = new Set<string>();
  let cursor = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf("<", from);
    if (open === -1) break;
    const name = blockNameAt(text, open, exhausted);
    if (!name) {
      from = open + 1;
      continue;
    }
    const close = findClosingTag(text, open + 1 + name.length, name);
    if (close === -1) {
      exhausted.add(name);
      from = open + 1;
      continue;
    }
    out.push(text.slice(cursor, open));
    cursor = close;
    from = close;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

function stripTags(text: string): string {
  const out: string[] = [];
  let cursor = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf("<", from);
    if (open === -1) break;
    const first = text[open + 1] === "/" ? open + 2 : open + 1;
    if (!isTagStart(text.charCodeAt(first))) {
      from = open + 1;
      continue;
    }
    out.push(text.slice(cursor, open));
    const close = text.indexOf(">", first);
    if (close === -1) {
      cursor = text.length;
      break;
    }
    cursor = close + 1;
    from = cursor;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

export function stripMarkup(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = dropControlChars(
      stripTags(stripBlocks(stripComments(current))),
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

export function checkMessage(
  raw: string,
  options: { truncated?: boolean } = {},
): MessageVerdict {
  const bounded = clip(raw, MAX_STORED_MESSAGE_CHARS);
  const truncated = options.truncated === true || bounded.length < raw.length;
  const stripped = stripMarkup(bounded);
  const reasons: string[] = [];
  if (stripped !== bounded) reasons.push("markup");
  if (truncated || stripped.length > MAX_MESSAGE_CHARS) {
    reasons.push("too_long");
  }
  return {
    sanitized: clip(stripped, MAX_MESSAGE_CHARS),
    flagged: reasons.length > 0,
    reasons,
  };
}
