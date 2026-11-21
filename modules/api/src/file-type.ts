import {
  ATTACHMENT_LIMITS,
  type AttachmentRejectionReason,
} from "@pw-support/contracts";

export type FileVerdict =
  | { ok: true; contentType: string }
  | { ok: false; reason: AttachmentRejectionReason };

const reject = (reason: AttachmentRejectionReason): FileVerdict => ({
  ok: false,
  reason,
});
const accept = (contentType: string): FileVerdict => ({
  ok: true,
  contentType,
});

const EXECUTABLE_EXTENSIONS = new Set([
  "exe",
  "dll",
  "bat",
  "cmd",
  "com",
  "msi",
  "scr",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "vbs",
  "jar",
  "app",
  "apk",
  "bin",
]);

const TEXT_TYPES: Record<string, string> = {
  csv: "text/csv",
  json: "application/json",
  log: "text/x-log",
  md: "text/markdown",
};

const OLE_TYPES: Record<string, string> = {
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
};

const OFFICE_TYPES = [
  {
    entry: "word/document.xml",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    entry: "xl/workbook.xml",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  {
    entry: "ppt/presentation.xml",
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
] as const;

const IMAGE_BRANDS = new Set(["heic", "heix", "hevc", "mif1", "msf1", "avif"]);
const MACHO_MAGIC = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
];

function startsWith(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  return magic.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

function isExecutable(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(bytes, [0x4d, 0x5a]) ||
    startsWith(bytes, [0x23, 0x21]) ||
    MACHO_MAGIC.some((magic) => startsWith(bytes, magic))
  );
}

function isVideo(bytes: Uint8Array): boolean {
  if (ascii(bytes, 4, 8) === "ftyp") {
    return !IMAGE_BRANDS.has(ascii(bytes, 8, 12));
  }
  return (
    startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) ||
    (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "AVI ") ||
    ascii(bytes, 0, 4) === "FLV\u0001" ||
    ascii(bytes, 0, 4) === "OggS" ||
    startsWith(bytes, [0x00, 0x00, 0x01, 0xba]) ||
    startsWith(bytes, [0x00, 0x00, 0x01, 0xb3]) ||
    startsWith(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])
  );
}

const EOCD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
const CENTRAL_SIGNATURE = [0x50, 0x4b, 0x01, 0x02];
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_COMMENT = 0xffff;
const ZIP64_COUNT = 0xffff;

export function zipEntryNames(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - EOCD_MIN_BYTES - EOCD_MAX_COMMENT);
  let eocd = -1;
  for (let at = bytes.length - EOCD_MIN_BYTES; at >= lowest; at--) {
    if (startsWith(bytes, EOCD_SIGNATURE, at)) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  if (count === ZIP64_COUNT) return [];
  let cursor = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let index = 0; index < count; index++) {
    if (
      cursor + 46 > bytes.length ||
      !startsWith(bytes, CENTRAL_SIGNATURE, cursor)
    ) {
      return null;
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    names.push(ascii(bytes, cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function classifyZip(bytes: Uint8Array): FileVerdict {
  const names = zipEntryNames(bytes);
  if (names === null) return reject("type_not_allowed");
  const office = OFFICE_TYPES.find(
    (candidate) =>
      names.includes(candidate.entry) && names.includes("[Content_Types].xml"),
  );
  return accept(office?.type ?? "application/zip");
}

function classifyText(filename: string, bytes: Uint8Array): FileVerdict {
  const extension = extensionOf(filename);
  if (EXECUTABLE_EXTENSIONS.has(extension)) return reject("executable");
  if (bytes.includes(0)) return reject("type_not_allowed");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return reject("type_not_allowed");
  }
  return accept(TEXT_TYPES[extension] ?? "text/plain");
}

export function detectFile(filename: string, bytes: Uint8Array): FileVerdict {
  if (isExecutable(bytes)) return reject("executable");
  if (isVideo(bytes)) return reject("video");
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return accept("image/png");
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return accept("image/jpeg");
  if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) {
    return accept("image/gif");
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return accept("image/webp");
  }
  if (ascii(bytes, 0, 5) === "%PDF-") return accept("application/pdf");
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const type = OLE_TYPES[extensionOf(filename)];
    return type ? accept(type) : reject("type_not_allowed");
  }
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, EOCD_SIGNATURE)
  ) {
    return classifyZip(bytes);
  }
  return classifyText(filename, bytes);
}

export interface AttachmentPreflight {
  index: number;
  size: number;
}

export function preflightAttachment(
  input: AttachmentPreflight,
): AttachmentRejectionReason | null {
  if (input.index >= ATTACHMENT_LIMITS.maxFiles) return "too_many_files";
  if (input.size > ATTACHMENT_LIMITS.maxBytes) return "too_large";
  if (input.size === 0) return "empty";
  return null;
}
