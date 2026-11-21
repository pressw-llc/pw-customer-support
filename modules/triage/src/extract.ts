import { attachmentKindFor } from "@pw-support/contracts";
import {
  DEFAULT_MAX_PDF_PAGES,
  type ExtractFormat,
  type ExtractRequest,
} from "./extract-core";
import {
  DEFAULT_EXTRACT_TIMEOUT_MS,
  runExtractorIsolated,
} from "./extract-sandbox";

export * from "./extract-core";
export * from "./extract-sandbox";

export interface ExtractLimits {
  maxCharsPerFile: number;
  maxCharsTotal: number;
  maxImages: number;
  maxImageBytes: number;
  timeoutMs?: number;
  maxPdfPages?: number;
}

export interface AttachmentInput {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes?: number;
  bytes?: Uint8Array;
  load?: () => Promise<Uint8Array>;
}

export interface ExtractOptions {
  workerUrl?: URL;
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

const OFFICE_FORMATS: Record<string, ExtractFormat> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

const IMAGE_FORMATS: Record<string, "png" | "jpeg" | "gif" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

type Plan =
  | { action: "skip"; reason: string }
  | {
      action: "image";
      mediaType: string;
      format: "png" | "jpeg" | "gif" | "webp";
    }
  | { action: "document"; format: ExtractFormat | "text" };

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

function capped(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

function planFor(
  input: AttachmentInput,
  limits: ExtractLimits,
  imagesSoFar: number,
): Plan {
  const contentType =
    input.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const kind = attachmentKindFor(contentType);
  const office = OFFICE_FORMATS[contentType];
  if (kind === "zip" && !office) {
    return { action: "skip", reason: "archive_not_extracted" };
  }
  if (kind === "image") {
    const format = IMAGE_FORMATS[contentType];
    if (!format) return { action: "skip", reason: "image_format_unsupported" };
    const size = input.sizeBytes ?? input.bytes?.byteLength ?? 0;
    if (size > limits.maxImageBytes) {
      return { action: "skip", reason: "image_too_large" };
    }
    if (imagesSoFar >= limits.maxImages) {
      return { action: "skip", reason: "image_limit" };
    }
    return { action: "image", mediaType: contentType, format };
  }
  if (kind === "pdf") return { action: "document", format: "pdf" };
  if (office) return { action: "document", format: office };
  if (kind === "office") {
    return { action: "skip", reason: "legacy_office_not_supported" };
  }
  if (kind !== null) return { action: "document", format: "text" };
  return { action: "skip", reason: "type_not_supported" };
}

async function bytesOf(input: AttachmentInput): Promise<Uint8Array> {
  if (input.bytes) return input.bytes;
  if (input.load) return input.load();
  throw new Error("attachment has neither bytes nor a loader");
}

async function rawTextOf(
  format: ExtractFormat | "text",
  bytes: Uint8Array,
  limits: ExtractLimits,
  options: ExtractOptions,
): Promise<{ raw: string } | { reason: string }> {
  const max = limits.maxCharsPerFile;
  if (format === "text") {
    const head = bytes.subarray(0, (max + 1) * 4);
    return { raw: new TextDecoder().decode(head) };
  }
  const request: ExtractRequest = {
    format,
    bytes,
    maxChars: max,
    maxPdfPages: limits.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES,
  };
  const result = await runExtractorIsolated(request, {
    timeoutMs: limits.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS,
    workerUrl: options.workerUrl,
  });
  if (result.ok) return { raw: result.text };
  return {
    reason:
      result.reason === "timeout" ? "extraction_timeout" : "extraction_failed",
  };
}

async function extractOne(
  input: AttachmentInput,
  plan: Exclude<Plan, { action: "skip" }>,
  limits: ExtractLimits,
  options: ExtractOptions,
): Promise<ExtractedItem> {
  const { id, filename } = input;
  const skipped = (reason: string): ExtractedItem => ({
    kind: "skipped",
    id,
    filename,
    reason,
  });
  try {
    const bytes = await bytesOf(input);
    if (plan.action === "image") {
      if (bytes.byteLength > limits.maxImageBytes) {
        return skipped("image_too_large");
      }
      return {
        kind: "image",
        id,
        filename,
        mediaType: plan.mediaType,
        format: plan.format,
        base64: Buffer.from(bytes).toString("base64"),
      };
    }
    const extracted = await rawTextOf(plan.format, bytes, limits, options);
    if ("reason" in extracted) return skipped(extracted.reason);
    const max = limits.maxCharsPerFile;
    const cleaned = cleanText(extracted.raw.slice(0, max + 1));
    if (cleaned === "") return skipped("no_text_found");
    const fit = capped(cleaned, max);
    return {
      kind: "document",
      id,
      filename,
      text: fit.text,
      truncated: fit.truncated || extracted.raw.length > max,
    };
  } catch {
    return skipped("extraction_failed");
  }
}

export async function extractAttachments(
  inputs: AttachmentInput[],
  limits: ExtractLimits,
  options: ExtractOptions = {},
): Promise<ExtractedItem[]> {
  const items: ExtractedItem[] = [];
  let remaining = limits.maxCharsTotal;
  let images = 0;
  for (const input of inputs) {
    const { id, filename } = input;
    const plan = planFor(input, limits, images);
    if (plan.action === "skip") {
      items.push({ kind: "skipped", id, filename, reason: plan.reason });
      continue;
    }
    if (plan.action === "document" && remaining <= 0) {
      items.push({
        kind: "skipped",
        id,
        filename,
        reason: "text_budget_exhausted",
      });
      continue;
    }
    const item = await extractOne(input, plan, limits, options);
    if (item.kind === "image") images += 1;
    if (item.kind === "document") {
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
