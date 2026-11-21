import { z } from "zod";

export const ATTACHMENT_LIMITS = {
  maxFiles: 10,
  maxBytes: 25 * 1024 * 1024,
} as const;

export const attachmentKinds = [
  "image",
  "pdf",
  "text",
  "log",
  "csv",
  "json",
  "office",
  "zip",
] as const;
export type AttachmentKind = (typeof attachmentKinds)[number];

export const ATTACHMENT_CONTENT_TYPES: Record<
  AttachmentKind,
  readonly string[]
> = {
  image: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  pdf: ["application/pdf"],
  text: ["text/plain", "text/markdown"],
  log: ["text/x-log", "application/x-log"],
  csv: ["text/csv"],
  json: ["application/json"],
  office: [
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  zip: ["application/zip", "application/x-zip-compressed"],
};

export function attachmentKindFor(contentType: string): AttachmentKind | null {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  for (const kind of attachmentKinds) {
    if (ATTACHMENT_CONTENT_TYPES[kind].includes(normalized)) return kind;
  }
  return null;
}

export function isVideoContentType(contentType: string): boolean {
  return contentType.trim().toLowerCase().startsWith("video/");
}

export const attachmentMetaSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().refine((value) => attachmentKindFor(value) !== null, {
    message: "Attachment type is not allowed",
  }),
  sizeBytes: z.number().int().positive().max(ATTACHMENT_LIMITS.maxBytes),
});
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

export const attachmentBatchSchema = z
  .array(attachmentMetaSchema)
  .max(ATTACHMENT_LIMITS.maxFiles);
