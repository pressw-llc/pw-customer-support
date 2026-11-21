import { attachmentKindFor } from "@pw-support/contracts";
import { unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";

export interface ExtractLimits {
  maxCharsPerFile: number;
  maxCharsTotal: number;
  maxImages: number;
  maxImageBytes: number;
}

export interface AttachmentInput {
  id: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export type ExtractedItem =
  | {
      kind: "document";
      id: string;
      filename: string;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "image";
      id: string;
      filename: string;
      mediaType: string;
      base64: string;
      format: "png" | "jpeg" | "gif" | "webp";
    }
  | { kind: "skipped"; id: string; filename: string; reason: string };

const MAX_UNZIPPED_BYTES = 40 * 1024 * 1024;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
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

function safeCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

function cleanText(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code >= 32;
    })
    .join("")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textRuns(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return Array.from(xml.matchAll(pattern), (match) =>
    decodeEntities(match[1] ?? ""),
  );
}

function unzipEntries(
  bytes: Uint8Array,
  accept: (name: string) => boolean,
): Record<string, string> {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (!accept(file.name)) return false;
      total += file.originalSize;
      return total <= MAX_UNZIPPED_BYTES;
    },
  });
  const decoder = new TextDecoder();
  return Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, decoder.decode(data)]),
  );
}

function numericOrder(a: string, b: string): number {
  const num = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
  return num(a) - num(b);
}

export function extractDocx(bytes: Uint8Array): string {
  const entries = unzipEntries(bytes, (name) => name === "word/document.xml");
  const xml = entries["word/document.xml"] ?? "";
  const paragraphs = xml
    .split(/<\/w:p>/)
    .map((paragraph) => textRuns(paragraph, "w:t").join(""));
  return paragraphs.join("\n");
}

export function extractPptx(bytes: Uint8Array): string {
  const entries = unzipEntries(bytes, (name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  );
  return Object.keys(entries)
    .sort(numericOrder)
    .map((name) => textRuns(entries[name] ?? "", "a:t").join("\n"))
    .join("\n\n");
}

export function extractXlsx(bytes: Uint8Array): string {
  const entries = unzipEntries(
    bytes,
    (name) =>
      name === "xl/sharedStrings.xml" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  );
  const shared = (entries["xl/sharedStrings.xml"] ?? "")
    .split(/<\/si>/)
    .slice(0, -1)
    .map((item) => textRuns(item, "t").join(""));
  const sheets = Object.keys(entries)
    .filter((name) => name.startsWith("xl/worksheets/"))
    .sort(numericOrder);
  return sheets
    .map((name) => {
      const rows = (entries[name] ?? "").split(/<\/row>/).slice(0, -1);
      return rows
        .map((row) =>
          Array.from(
            row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g),
            (cell) => {
              const attributes = cell[1] ?? "";
              const inner = cell[2] ?? "";
              const inline = textRuns(inner, "t").join("");
              if (inline) return inline;
              const value = textRuns(inner, "v")[0] ?? "";
              return /\bt="s"/.test(attributes)
                ? (shared[Number(value)] ?? "")
                : value;
            },
          ).join("\t"),
        )
        .join("\n");
    })
    .join("\n\n");
}

export async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

const OFFICE_EXTRACTORS: Record<string, (bytes: Uint8Array) => string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    extractDocx,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    extractPptx,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    extractXlsx,
};

const IMAGE_FORMATS: Record<string, "png" | "jpeg" | "gif" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function capped(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

async function extractOne(
  input: AttachmentInput,
  limits: ExtractLimits,
  imagesSoFar: number,
): Promise<ExtractedItem> {
  const { id, filename } = input;
  const contentType =
    input.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const kind = attachmentKindFor(contentType);
  const skipped = (reason: string): ExtractedItem => ({
    kind: "skipped",
    id,
    filename,
    reason,
  });
  if (kind === "zip" && !(contentType in OFFICE_EXTRACTORS)) {
    return skipped("archive_not_extracted");
  }
  if (kind === "image") {
    const format = IMAGE_FORMATS[contentType];
    if (!format) return skipped("image_format_unsupported");
    if (input.bytes.byteLength > limits.maxImageBytes) {
      return skipped("image_too_large");
    }
    if (imagesSoFar >= limits.maxImages) return skipped("image_limit");
    return {
      kind: "image",
      id,
      filename,
      mediaType: contentType,
      format,
      base64: Buffer.from(input.bytes).toString("base64"),
    };
  }
  try {
    let raw: string | null = null;
    if (kind === "pdf") raw = await extractPdf(input.bytes);
    else if (contentType in OFFICE_EXTRACTORS) {
      raw = OFFICE_EXTRACTORS[contentType]?.(input.bytes) ?? null;
    } else if (kind === "office") return skipped("legacy_office_not_supported");
    else if (kind !== null) raw = new TextDecoder().decode(input.bytes);
    if (raw === null) return skipped("type_not_supported");
    const cleaned = cleanText(raw);
    if (cleaned === "") return skipped("no_text_found");
    const { text, truncated } = capped(cleaned, limits.maxCharsPerFile);
    return { kind: "document", id, filename, text, truncated };
  } catch {
    return skipped("extraction_failed");
  }
}

export async function extractAttachments(
  inputs: AttachmentInput[],
  limits: ExtractLimits,
): Promise<ExtractedItem[]> {
  const items: ExtractedItem[] = [];
  let remaining = limits.maxCharsTotal;
  let images = 0;
  for (const input of inputs) {
    const item = await extractOne(input, limits, images);
    if (item.kind === "image") images += 1;
    if (item.kind === "document") {
      if (remaining <= 0) {
        items.push({
          kind: "skipped",
          id: item.id,
          filename: item.filename,
          reason: "text_budget_exhausted",
        });
        continue;
      }
      const fit = capped(item.text, remaining);
      remaining -= fit.text.length;
      items.push({
        ...item,
        text: fit.text,
        truncated: item.truncated || fit.truncated,
      });
      continue;
    }
    items.push(item);
  }
  return items;
}
