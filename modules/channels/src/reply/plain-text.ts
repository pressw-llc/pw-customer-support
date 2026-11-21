import { stripMarkup } from "@pw-support/contracts";

const URL_STOP = new Set([" ", "\t", "\n", "\r", ")", "]", "<", ">", '"']);
const HOST_STOP = new Set(["/", "?", "#", ":", "@"]);

function isLetterAt(text: string, index: number, lower: string): boolean {
  return (text.charCodeAt(index) | 0x20) === lower.charCodeAt(0);
}

function schemeLengthAt(text: string, index: number): number {
  if (
    !isLetterAt(text, index, "h") ||
    !isLetterAt(text, index + 1, "t") ||
    !isLetterAt(text, index + 2, "t") ||
    !isLetterAt(text, index + 3, "p")
  ) {
    return 0;
  }
  const secure = isLetterAt(text, index + 4, "s") ? 1 : 0;
  return text.startsWith("://", index + 4 + secure) ? 7 + secure : 0;
}

function isLinearHost(text: string, start: number, end: number): boolean {
  let hostEnd = start;
  while (hostEnd < end && !HOST_STOP.has(text.charAt(hostEnd))) hostEnd++;
  const host = text.slice(start, hostEnd).toLowerCase();
  return host === "linear.app" || host.endsWith(".linear.app");
}

function dropLinearUrls(text: string): string {
  const out: string[] = [];
  let literalFrom = 0;
  let index = 0;
  while (index < text.length) {
    const scheme = schemeLengthAt(text, index);
    if (scheme === 0) {
      index++;
      continue;
    }
    let end = index + scheme;
    while (end < text.length && !URL_STOP.has(text.charAt(end))) end++;
    if (isLinearHost(text, index + scheme, end)) {
      out.push(text.slice(literalFrom, index));
      literalFrom = end;
    }
    index = end;
  }
  out.push(text.slice(literalFrom));
  return out.join("");
}

function createFinder(text: string, needle: string) {
  let cached = -2;
  return (from: number): number => {
    if (cached === -1) return -1;
    if (cached < from) cached = text.indexOf(needle, from);
    return cached;
  };
}

function linksToText(text: string): string {
  const out: string[] = [];
  const nextBracket = createFinder(text, "]");
  const nextParen = createFinder(text, ")");
  let literalFrom = 0;
  let index = 0;
  const link = (open: number): { label: string; end: number } | null => {
    const close = nextBracket(open + 1);
    if (close === -1 || text.charAt(close + 1) !== "(") return null;
    const paren = nextParen(close + 2);
    if (paren === -1) return null;
    return { label: text.slice(open + 1, close), end: paren + 1 };
  };
  while (index < text.length) {
    const image = text.charAt(index) === "!" && text.charAt(index + 1) === "[";
    const open = image ? index + 1 : index;
    const found = image || text.charAt(index) === "[" ? link(open) : null;
    if (!found) {
      index++;
      continue;
    }
    out.push(text.slice(literalFrom, index));
    if (!image) out.push(found.label);
    literalFrom = found.end;
    index = found.end;
  }
  out.push(text.slice(literalFrom));
  return out.join("");
}

export function plainStaffText(markdown: string): string {
  const withoutLinks = dropLinearUrls(linksToText(stripMarkup(markdown)));
  return withoutLinks
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}
