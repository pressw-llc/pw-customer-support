import { z } from "zod";
import { hashedIdSchema } from "./identity";
import {
  messageAudienceSchema,
  messageAuthorSchema,
  originChannelSchema,
} from "./message";

export const SUPPORT_KEY_HEADER = "X-Support-Key";
export const SUPPORT_USER_HEADER = "X-Support-User";

export const MAX_MESSAGE_CHARS = 10_000;
export const PREVIEW_CHARS = 140;

export const attachmentRejectionReasons = [
  "too_many_files",
  "too_large",
  "empty",
  "executable",
  "video",
  "type_not_allowed",
  "storage_failed",
] as const;
export const attachmentRejectionReasonSchema = z.enum(
  attachmentRejectionReasons,
);
export type AttachmentRejectionReason = z.infer<
  typeof attachmentRejectionReasonSchema
>;

export const supportIdentitySchema = z.object({
  projectKey: z.string().min(1),
  hashedId: hashedIdSchema,
});
export type SupportIdentity = z.infer<typeof supportIdentitySchema>;

export const fileResultSchema = z.object({
  filename: z.string(),
  status: z.enum(["stored", "rejected"]),
  reason: attachmentRejectionReasonSchema.optional(),
});
export type FileResult = z.infer<typeof fileResultSchema>;

export const attachmentSummarySchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().positive(),
});
export type AttachmentSummary = z.infer<typeof attachmentSummarySchema>;

export const threadMessageSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  flagged: z.boolean(),
  author: messageAuthorSchema,
  authorName: z.string().nullable().default(null),
  audience: messageAudienceSchema,
  originChannel: originChannelSchema,
  createdAt: z.string(),
  attachments: z.array(attachmentSummarySchema),
});
export type ThreadMessage = z.infer<typeof threadMessageSchema>;

export const intakeResultSchema = z.object({
  requestId: z.string().uuid(),
  message: threadMessageSchema,
  files: z.array(fileResultSchema),
  truncated: z.boolean().default(false),
});
export type IntakeResult = z.infer<typeof intakeResultSchema>;

const requestStatusSchema = z.enum(["open", "triaged", "closed"]);

export const requestSummarySchema = z.object({
  id: z.string().uuid(),
  status: requestStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  unreadCount: z.number().int().nonnegative(),
  lastMessage: z
    .object({
      preview: z.string(),
      author: messageAuthorSchema,
      originChannel: originChannelSchema,
      createdAt: z.string(),
    })
    .nullable(),
});
export type RequestSummary = z.infer<typeof requestSummarySchema>;

export const requestListSchema = z.object({
  requests: z.array(requestSummarySchema),
});
export type RequestList = z.infer<typeof requestListSchema>;

export const threadSchema = z.object({
  id: z.string().uuid(),
  status: requestStatusSchema,
  createdAt: z.string(),
  messages: z.array(threadMessageSchema),
});
export type Thread = z.infer<typeof threadSchema>;
