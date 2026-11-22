import { z } from "zod";
import { channelKeySchema, channelPrefixSchema } from "./channel-key";
import { humanTriageReasonSchema } from "./triage-job";

export const MCP_SERVER_NAME = "pw-support";
export const MCP_PATH = "/mcp";
export const MCP_LAPTOP_PATH = "/mcp/laptop";
export const WATCHER_PATH = "/laptop/watcher";
export const WATCHER_HEADER = "X-Support-Watcher";
export const SUBMIT_HEADER = "X-Support-Submit";
export const MCP_MAX_QUERY_ROWS = 50;
export const MCP_MAX_SUBSCRIPTIONS = 100;

export const interactiveToolNames = [
  "subscriptions_list",
  "subscription_add",
  "subscription_remove",
  "requests_query",
  "request_get",
  "jobs_offers",
] as const;
export const laptopToolNames = [
  "job_claim",
  "job_renew",
  "job_submit_result",
] as const;
export const mcpToolNames = [...interactiveToolNames, ...laptopToolNames];
export type McpToolName = (typeof mcpToolNames)[number];

export const watcherRegistrationSchema = z.object({
  machineId: z.string().uuid(),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type WatcherRegistration = z.infer<typeof watcherRegistrationSchema>;

export const watcherRevocationSchema = z.object({
  machineId: z.string().uuid(),
});

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

const STATE_TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const TICKET_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,19}-\d{1,9}$/;
const TICKET_URL =
  /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_.-]+\/issue\/[A-Za-z][A-Za-z0-9]{0,19}-\d{1,9}$/;

export const stateTokenSchema = z.string().regex(STATE_TOKEN);
export const timestampSchema = z.string().datetime();
export const ticketIdentifierSchema = z.string().regex(TICKET_IDENTIFIER);
export const ticketUrlSchema = z.string().regex(TICKET_URL);

export function safeTicketLink(
  identifier: string,
  url: string,
): { identifier: string; url: string } | null {
  if (!TICKET_IDENTIFIER.test(identifier)) return null;
  const match = /^(https?:\/\/[^/?#\s]+\/[^/?#\s]+\/issue\/)([^/?#\s]+)/.exec(
    url,
  );
  if (!match || match[2] !== identifier) return null;
  const link = `${match[1]}${identifier}`;
  return TICKET_URL.test(link) ? { identifier, url: link } : null;
}

export const subscriptionSchema = z.object({
  prefix: channelPrefixSchema,
  createdAt: timestampSchema,
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const engineerRequestSummarySchema = z.object({
  id: z.string().uuid(),
  channelKey: channelKeySchema,
  status: stateTokenSchema,
  createdAt: timestampSchema,
  subscribed: z.boolean(),
  job: z
    .object({
      status: stateTokenSchema,
      outcome: stateTokenSchema.nullable(),
      claimedByKind: stateTokenSchema.nullable(),
      leaseExpiresAt: timestampSchema.nullable(),
    })
    .nullable(),
  ticket: z
    .object({ identifier: ticketIdentifierSchema, url: ticketUrlSchema })
    .nullable(),
  heldReplies: z.boolean(),
  flaggedReplies: z.boolean(),
});
export type EngineerRequestSummary = z.infer<
  typeof engineerRequestSummarySchema
>;

export const engineerRequestDetailSchema = z.object({
  request: engineerRequestSummarySchema,
  events: z.array(
    z.object({ type: stateTokenSchema, createdAt: timestampSchema }),
  ),
  counts: z.object({
    messages: z.number().int(),
    attachments: z.number().int(),
    characters: z.number().int(),
  }),
  replies: z.array(
    z.object({
      status: stateTokenSchema,
      flagged: z.boolean(),
      wordingScore: z.number(),
      createdAt: timestampSchema,
    }),
  ),
});
export type EngineerRequestDetail = z.infer<typeof engineerRequestDetailSchema>;

export const jobOfferSchema = z.object({
  jobId: z.string().uuid(),
  channelKey: channelKeySchema,
  createdAt: timestampSchema,
  ageSeconds: z.number().int(),
  cloudAvailableAt: timestampSchema,
  cloudWaitSeconds: z.number().int(),
  leaseSeconds: z.number().int(),
});
export type JobOffer = z.infer<typeof jobOfferSchema>;

export const jobClaimResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    jobId: z.string().uuid(),
    claimToken: z.string().uuid(),
    submitToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
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

const subscriptionsOutput = z.object({
  subscriptions: z.array(subscriptionSchema),
});

export const interactiveToolOutputs = {
  subscriptions_list: subscriptionsOutput,
  subscription_add: z.object({
    subscription: subscriptionSchema,
    created: z.boolean(),
  }),
  subscription_remove: z.object({ removed: z.boolean() }),
  requests_query: z.object({ requests: z.array(engineerRequestSummarySchema) }),
  request_get: z.object({ detail: engineerRequestDetailSchema.nullable() }),
  jobs_offers: z.object({ offers: z.array(jobOfferSchema) }),
} as const satisfies Record<
  (typeof interactiveToolNames)[number],
  z.ZodTypeAny
>;
