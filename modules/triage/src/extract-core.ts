import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { getDocumentProxy } from "unpdf";

export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 20_000;
export const DEFAULT_MAX_PDF_PAGES = 40;

const FEED_BYTES = 4 * 1024;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function safeCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

export function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, body: string) => {
      if (body.startsWith("#x")) {
        return safeCodePoint(Number.parseInt(body.slice(2), 16), match);
      }
      if (body.startsWith("#")) {
        return safeCodePoint(Number.parseInt(body.slice(1), 10), match);
      }
      return ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

class TextBudget {
  private readonly parts: string[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  get remaining(): number {
    return this.limit - this.size;
  }

  get full(): boolean {
    return this.remaining <= 0;
  }

  add(text: string): void {
    if (this.full || text === "") return;
    const fit =
      text.length > this.remaining ? text.slice(0, this.remaining) : text;
    this.parts.push(fit);
    this.size += fit.length;
  }

  toString(): string {
    return this.parts.join("");
  }
}

function budgetFor(maxChars: number): TextBudget {
  return new TextBudget(maxChars + 1);
}

function endsTagName(code: number): boolean {
  return (
    code === 62 ||
    code === 32 ||
    code === 9 ||
    code === 10 ||
    code === 13 ||
    code === 47
  );
}

export function textRuns(
  xml: string,
  tag: string,
  limit = Number.POSITIVE_INFINITY,
  maxRuns = Number.POSITIVE_INFINITY,
): string[] {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const runs: string[] = [];
  let size = 0;
  let pos = 0;
  while (size < limit && runs.length < maxRuns) {
    const start = xml.indexOf(open, pos);
    if (start < 0) break;
    const nameEnd = start + open.length;
    if (!endsTagName(xml.charCodeAt(nameEnd))) {
      pos = nameEnd;
      continue;
    }
    const gt = xml.indexOf(">", nameEnd);
    if (gt < 0) break;
    if (xml.charCodeAt(gt - 1) === 47) {
      pos = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) break;
    const text = decodeEntities(xml.slice(gt + 1, end));
    runs.push(text);
    size += text.length;
    pos = end + close.length;
  }
  return runs;
}

function* pieces(xml: string, separator: string): Generator<string> {
  let pos = 0;
  while (pos < xml.length) {
    const end = xml.indexOf(separator, pos);
    if (end < 0) return;
    yield xml.slice(pos, end);
    pos = end + separator.length;
  }
}

export function unzipEntries(
  bytes: Uint8Array,
  accept: (name: string) => boolean,
): Record<string, string> {
  const chunks = new Map<string, Uint8Array[]>();
  let total = 0;
  let stop = false;
  let entries = 0;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    entries += 1;
    if (stop || !accept(file.name)) return;
    const parts: Uint8Array[] = [];
    let size = 0;
    chunks.set(file.name, parts);
    file.ondata = (error, data) => {
      if (error || stop) {
        stop = true;
        return;
      }
      const room = Math.min(MAX_ENTRY_BYTES - size, MAX_ARCHIVE_BYTES - total);
      const fit = data.length > room ? data.subarray(0, room) : data;
      parts.push(fit);
      size += fit.length;
      total += fit.length;
      if (fit.length < data.length || size >= MAX_ENTRY_BYTES) stop = true;
    };
    file.start();
  };
  for (let offset = 0; offset < bytes.length && !stop; offset += FEED_BYTES) {
    const end = Math.min(offset + FEED_BYTES, bytes.length);
    unzip.push(bytes.subarray(offset, end), end === bytes.length);
  }
  if (entries === 0) throw new Error("not a zip archive");
  const decoder = new TextDecoder();
  return Object.fromEntries(
    [...chunks].map(([name, parts]) => [
      name,
      decoder.decode(Buffer.concat(parts)),
    ]),
  );
}

function numericOrder(a: string, b: string): number {
  const num = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
  return num(a) - num(b);
}

export function extractDocx(
  bytes: Uint8Array,
  maxChars = DEFAULT_MAX_CHARS,
): string {
  const xml =
    unzipEntries(bytes, (name) => name === "word/document.xml")[
      "word/document.xml"
    ] ?? "";
  const out = budgetFor(maxChars);
  let pos = 0;
  while (!out.full) {
    const end = xml.indexOf("</w:p>", pos);
    const paragraph = xml.slice(pos, end < 0 ? xml.length : end);
    out.add(textRuns(paragraph, "w:t", out.remaining).join(""));
    if (end < 0) break;
    out.add("\n");
    pos = end + "</w:p>".length;
  }
  return out.toString();
}

export function extractPptx(
  bytes: Uint8Array,
  maxChars = DEFAULT_MAX_CHARS,
): string {
  const entries = unzipEntries(bytes, (name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  );
  const out = budgetFor(maxChars);
  let first = true;
  for (const name of Object.keys(entries).sort(numericOrder)) {
    if (out.full) break;
    if (!first) out.add("\n\n");
    first = false;
    out.add(textRuns(entries[name] ?? "", "a:t", out.remaining).join("\n"));
  }
  return out.toString();
}

function cellText(inner: string, attributes: string, shared: string[]): string {
  const inline = textRuns(inner, "t").join("");
  if (inline) return inline;
  const value = textRuns(inner, "v", Number.POSITIVE_INFINITY, 1)[0] ?? "";
  return /\bt="s"/.test(attributes) ? (shared[Number(value)] ?? "") : value;
}

function rowCells(row: string, shared: string[], out: TextBudget): void {
  let pos = 0;
  let first = true;
  while (!out.full) {
    const start = row.indexOf("<c", pos);
    if (start < 0) return;
    const nameEnd = start + 2;
    if (!endsTagName(row.charCodeAt(nameEnd))) {
      pos = nameEnd;
      continue;
    }
    const gt = row.indexOf(">", nameEnd);
    if (gt < 0) return;
    let text = "";
    if (row.charCodeAt(gt - 1) === 47) {
      pos = gt + 1;
    } else {
      const end = row.indexOf("</c>", gt + 1);
      if (end < 0) return;
      text = cellText(row.slice(gt + 1, end), row.slice(nameEnd, gt), shared);
      pos = end + 4;
    }
    if (!first) out.add("\t");
    first = false;
    out.add(text);
  }
}

export function extractXlsx(
  bytes: Uint8Array,
  maxChars = DEFAULT_MAX_CHARS,
): string {
  const entries = unzipEntries(
    bytes,
    (name) =>
      name === "xl/sharedStrings.xml" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  );
  const shared = Array.from(
    pieces(entries["xl/sharedStrings.xml"] ?? "", "</si>"),
    (item) => textRuns(item, "t").join(""),
  );
  const out = budgetFor(maxChars);
  const sheets = Object.keys(entries)
    .filter((name) => name.startsWith("xl/worksheets/"))
    .sort(numericOrder);
  let firstSheet = true;
  for (const name of sheets) {
    if (out.full) break;
    if (!firstSheet) out.add("\n\n");
    firstSheet = false;
    let firstRow = true;
    for (const row of pieces(entries[name] ?? "", "</row>")) {
      if (out.full) break;
      if (!firstRow) out.add("\n");
      firstRow = false;
      rowCells(row, shared, out);
    }
  }
  return out.toString();
}

export async function extractPdf(
  bytes: Uint8Array,
  options: { maxChars?: number; maxPages?: number } = {},
): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out = budgetFor(options.maxChars ?? DEFAULT_MAX_CHARS);
  const pages = Math.min(
    pdf.numPages,
    options.maxPages ?? DEFAULT_MAX_PDF_PAGES,
  );
  for (let number = 1; number <= pages && !out.full; number += 1) {
    const content = await (await pdf.getPage(number)).getTextContent();
    const text = content.items
      .map((item) =>
        "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "",
      )
      .join("");
    if (number > 1) out.add("\n");
    out.add(text);
  }
  return out
    .toString()
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n");
}

export const EXTRACT_FORMATS = ["pdf", "docx", "pptx", "xlsx"] as const;
export type ExtractFormat = (typeof EXTRACT_FORMATS)[number];

export interface ExtractRequest {
  format: ExtractFormat;
  bytes: Uint8Array;
  maxChars: number;
  maxPdfPages: number;
}

export async function runExtractor(request: ExtractRequest): Promise<string> {
  const { format, bytes, maxChars } = request;
  if (format === "pdf") {
    return extractPdf(bytes, { maxChars, maxPages: request.maxPdfPages });
  }
  if (format === "docx") return extractDocx(bytes, maxChars);
  if (format === "pptx") return extractPptx(bytes, maxChars);
  return extractXlsx(bytes, maxChars);
}
