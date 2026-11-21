import { z } from "zod";
import { RESOURCE_NAMES } from "./resources";

export const ACK_WARN_MINUTES = 15;
export const ACK_CRITICAL_MINUTES = 60;

export const ADMIN_CHANNEL_KEY = "pw-admin";
export const SECRET_SCOPE_GLOBAL = "global";
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const slugSchema = z.string().trim().min(1).max(64).regex(SLUG);

export const MAX_CC_LIST = 50;
export const MAX_SECRET_CHARS = 4096;
export const KEY_MASK_VISIBLE = 4;

export const integrationKinds = [
  "linear_api_key",
  "linear_webhook_secret",
  "typesafe_api_key",
] as const;
export const integrationKindSchema = z.enum(integrationKinds);
export type IntegrationKind = z.infer<typeof integrationKindSchema>;

export interface IntegrationDefinition {
  label: string;
  secretName: string;
  envVar: string;
}

export const INTEGRATIONS: Record<IntegrationKind, IntegrationDefinition> = {
  linear_api_key: {
    label: "Linear API key",
    secretName: "linear-api-key",
    envVar: "LINEAR_API_KEY",
  },
  linear_webhook_secret: {
    label: "Linear webhook secret",
    secretName: "linear-webhook-secret",
    envVar: "LINEAR_WEBHOOK_SECRET",
  },
  typesafe_api_key: {
    label: "TypeSafe (Jev) API key",
    secretName: "typesafe-api-key",
    envVar: "TYPESAFE_API_KEY",
  },
};

export function integrationKindForSecretName(
  secretName: string,
): IntegrationKind | undefined {
  return integrationKinds.find(
    (kind) => INTEGRATIONS[kind].secretName === secretName,
  );
}

export function resolveSecretsScope(
  env: Record<string, string | undefined> = process.env,
): string {
  const scope = env.SECRETS_SCOPE;
  return scope && slugSchema.safeParse(scope).success
    ? scope
    : SECRET_SCOPE_GLOBAL;
}

export function secretId(scope: string, secretName: string): string {
  return `${RESOURCE_NAMES.secretsPrefix}${scope}/${secretName}`;
}

const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const ccListSchema = z
  .array(emailSchema)
  .max(MAX_CC_LIST)
  .transform((emails) => [...new Set(emails)]);
export type CcList = z.output<typeof ccListSchema>;

export const createProjectInputSchema = z.object({
  clientSlug: slugSchema,
  projectSlug: slugSchema,
  name: z.string().trim().min(1).max(120),
  linearTeamId: z.string().trim().min(1).max(100).nullish(),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const updateProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    linearTeamId: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field",
  });
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

export const ccListInputSchema = z.object({ emails: ccListSchema });

export const saveIntegrationInputSchema = z.object({
  value: z.string().trim().min(1).max(MAX_SECRET_CHARS),
});

export const adminRequestFiltersSchema = z.object({
  projectId: z.string().uuid().optional(),
  status: z.string().trim().min(1).max(40).optional(),
  flaggedReplies: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  needsHuman: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
});
export type AdminRequestFilters = z.output<typeof adminRequestFiltersSchema>;

const isoDate = z.string();

export const staffIdentitySchema = z.object({
  sub: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
});
export type StaffIdentity = z.infer<typeof staffIdentitySchema>;

export const adminRequestItemSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  clientSlug: z.string(),
  projectSlug: z.string(),
  customer: z.string(),
  channelKey: z.string(),
  status: z.string(),
  createdAt: isoDate,
  acknowledgedAt: isoDate.nullable(),
  ticket: z.object({ identifier: z.string(), url: z.string() }).nullable(),
  triageOutcome: z.string().nullable(),
  needsHumanTriage: z.boolean(),
  flaggedReplies: z.boolean(),
  heldReplies: z.boolean(),
  preview: z.string(),
});
export type AdminRequestItem = z.infer<typeof adminRequestItemSchema>;

export const adminRequestListSchema = z.object({
  items: z.array(adminRequestItemSchema),
  nextCursor: z.string().nullable(),
});
export type AdminRequestList = z.infer<typeof adminRequestListSchema>;

export const adminAttachmentSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
});

export const adminMessageSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  bodyFlagged: z.boolean(),
  originChannel: z.string(),
  author: z.string(),
  audience: z.string(),
  createdAt: isoDate,
  attachments: z.array(adminAttachmentSchema),
});

export const adminEventSchema = z.object({
  seq: z.number(),
  type: z.string(),
  createdAt: isoDate,
  payload: z.record(z.unknown()),
});
export type AdminEvent = z.infer<typeof adminEventSchema>;

export const adminJudgmentSchema = z.object({
  kind: z.string(),
  score: z.number(),
  threshold: z.number(),
  flagged: z.boolean(),
  createdAt: isoDate,
});

export const adminJobSchema = z.object({
  status: z.string(),
  outcome: z.string().nullable(),
  attempts: z.number(),
  claimedByKind: z.string().nullable(),
  claimedBy: z.string().nullable(),
  completedAt: isoDate.nullable(),
});

export const adminRequestDetailSchema = z.object({
  request: adminRequestItemSchema,
  messages: z.array(adminMessageSchema),
  rejections: z.array(
    z.object({
      filename: z.string(),
      reason: z.string(),
      sizeBytes: z.number(),
    }),
  ),
  events: z.array(adminEventSchema),
  judgments: z.array(adminJudgmentSchema),
  job: adminJobSchema.nullable(),
  claims: z.array(adminEventSchema),
  replyFlags: z.array(adminEventSchema),
});
export type AdminRequestDetail = z.infer<typeof adminRequestDetailSchema>;

export const adminKeySchema = z.object({
  id: z.string().uuid(),
  masked: z.string(),
  createdAt: isoDate,
  revokedAt: isoDate.nullable(),
});
export type AdminKey = z.infer<typeof adminKeySchema>;

export const adminProjectSchema = z.object({
  id: z.string().uuid(),
  clientSlug: z.string(),
  projectSlug: z.string(),
  name: z.string(),
  linearTeamId: z.string().nullable(),
  ccList: z.array(z.string()),
  createdAt: isoDate,
  keys: z.array(adminKeySchema),
});
export type AdminProject = z.infer<typeof adminProjectSchema>;

export const mintedKeySchema = adminKeySchema.extend({ key: z.string() });
export type MintedKey = z.infer<typeof mintedKeySchema>;

export const integrationStatusSchema = z.object({
  kind: integrationKindSchema,
  label: z.string(),
  configured: z.boolean(),
  updatedAt: isoDate.nullable(),
  updatedBy: z.string().nullable(),
});
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export function maskProjectKey(key: string): string {
  const tail = key.slice(-KEY_MASK_VISIBLE);
  return `pk_••••${tail}`;
}

export function shortHash(hashedId: string): string {
  return hashedId.slice(0, 8);
}

export type AckState = "waiting" | "warn" | "critical" | "acknowledged";

export function ackState(
  createdAt: Date,
  acknowledgedAt: Date | null,
  now: Date,
): { state: AckState; seconds: number } {
  const end = acknowledgedAt ?? now;
  const seconds = Math.max(
    0,
    Math.floor((end.getTime() - createdAt.getTime()) / 1000),
  );
  if (acknowledgedAt) return { state: "acknowledged", seconds };
  if (seconds >= ACK_CRITICAL_MINUTES * 60) {
    return { state: "critical", seconds };
  }
  if (seconds >= ACK_WARN_MINUTES * 60) return { state: "warn", seconds };
  return { state: "waiting", seconds };
}
