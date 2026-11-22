import { z } from "zod";
import { channelPrefixSchema } from "./channel-key";
import { humanTriageReasonSchema } from "./triage-job";

export const MCP_SERVER_NAME = "pw-support";
export const MCP_PATH = "/mcp";
export const MCP_MAX_QUERY_ROWS = 50;
export const MCP_MAX_SUBSCRIPTIONS = 100;

export const mcpToolNames = [
  "subscriptions_list",
  "subscription_add",
  "subscription_remove",
  "requests_query",
  "request_get",
  "jobs_offers",
  "job_claim",
  "job_renew",
  "job_submit_result",
] as const;
export type McpToolName = (typeof mcpToolNames)[number];

export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    source: z.object({
      type: z.literal("base64"),
      media_type: z.enum([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
      ]),
      data: z.string(),
    }),
  }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const nothingToDoReasonSchema = z.union([
  humanTriageReasonSchema,
  z.literal("preparation_failed"),
  z.literal("lease_lost"),
]);
export type NothingToDoReason = z.infer<typeof nothingToDoReasonSchema>;

export type LaptopPrepared =
  | { status: "ready"; content: ContentBlock[] }
  | { status: "nothing_to_do"; reason: NothingToDoReason };

export const subscriptionSchema = z.object({
  prefix: z.string(),
  createdAt: z.string(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const engineerRequestSummarySchema = z.object({
  id: z.string().uuid(),
  channelKey: z.string(),
  status: z.string(),
  createdAt: z.string(),
  subscribed: z.boolean(),
  job: z
    .object({
      status: z.string(),
      outcome: z.string().nullable(),
      claimedByKind: z.string().nullable(),
      leaseExpiresAt: z.string().nullable(),
    })
    .nullable(),
  ticket: z.object({ identifier: z.string(), url: z.string() }).nullable(),
  heldReplies: z.boolean(),
  flaggedReplies: z.boolean(),
});
export type EngineerRequestSummary = z.infer<
  typeof engineerRequestSummarySchema
>;

export const engineerRequestDetailSchema = z.object({
  request: engineerRequestSummarySchema,
  events: z.array(z.object({ type: z.string(), createdAt: z.string() })),
  messages: z
    .array(
      z.object({
        author: z.string(),
        createdAt: z.string(),
        body: z.string(),
      }),
    )
    .nullable(),
});
export type EngineerRequestDetail = z.infer<typeof engineerRequestDetailSchema>;

export const jobOfferSchema = z.object({
  jobId: z.string().uuid(),
  channelKey: z.string(),
  createdAt: z.string(),
  ageSeconds: z.number().int(),
  cloudAvailableAt: z.string(),
  cloudWaitSeconds: z.number().int(),
  leaseSeconds: z.number().int(),
});
export type JobOffer = z.infer<typeof jobOfferSchema>;

export const jobClaimResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    jobId: z.string().uuid(),
    claimToken: z.string().uuid(),
    leaseExpiresAt: z.string(),
    leaseSeconds: z.number().int(),
    content: z.array(contentBlockSchema),
  }),
  z.object({
    status: z.literal("nothing_to_do"),
    nothingToDo: nothingToDoReasonSchema,
  }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum(["not_offered", "lost_race"]),
  }),
]);
export type JobClaimResult = z.infer<typeof jobClaimResultSchema>;

export const jobRenewResultSchema = z.object({
  renewed: z.boolean(),
  leaseExpiresAt: z.string().nullable(),
});

export const submitIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const jobSubmitResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), outcome: z.string() }),
  z.object({
    accepted: z.literal(false),
    reason: z.enum(["stale_claim", "invalid_payload"]),
    issues: z.array(submitIssueSchema),
  }),
]);
export type JobSubmitResult = z.infer<typeof jobSubmitResultSchema>;

export const mcpInputs = {
  subscriptions_list: {},
  subscription_add: { prefix: channelPrefixSchema },
  subscription_remove: { prefix: channelPrefixSchema },
  requests_query: {
    channelPrefix: channelPrefixSchema.optional(),
    status: z.string().trim().min(1).max(40).optional(),
    limit: z.number().int().min(1).max(MCP_MAX_QUERY_ROWS).default(20),
  },
  request_get: { requestId: z.string().uuid() },
  jobs_offers: {},
  job_claim: { jobId: z.string().uuid() },
  job_renew: { jobId: z.string().uuid(), claimToken: z.string().uuid() },
  job_submit_result: {
    jobId: z.string().uuid(),
    claimToken: z.string().uuid(),
    result: z.unknown(),
  },
} as const;
