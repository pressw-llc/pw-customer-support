import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  engineerRequestDetailSchema,
  engineerRequestSummarySchema,
  type JobClaimResult,
  type JobSubmitResult,
  jobClaimResultSchema,
  jobOfferSchema,
  jobRenewResultSchema,
  jobSubmitResultSchema,
  type LaptopPrepared,
  MCP_PATH,
  MCP_SERVER_NAME,
  mcpInputs,
  type StaffIdentity,
  subscriptionSchema,
  type TriageTiming,
  type WakeSender,
} from "@pw-support/contracts";
import {
  addSubscription,
  claimTriageJob,
  extendTriageLease,
  getRequestDetailForEngineer,
  getTriageJob,
  hitRateLimit,
  isJobOffered,
  listJobOffers,
  listSubscriptions,
  queryRequestSummaries,
  removeSubscription,
  type SubmitInput,
  type SubmitResult,
  SubscriptionLimitError,
  type SupportDb,
  type TriageJob,
} from "@pw-support/db";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { parseBearer, type TokenValidator } from "./auth";

export interface LaptopBackend {
  prepare(job: TriageJob): Promise<LaptopPrepared>;
  submit(input: SubmitInput): Promise<SubmitResult>;
}

export interface McpConfig {
  audiences: string[];
  perWindow: number;
  windowSeconds: number;
  maxBodyBytes: number;
}

export interface McpDeps {
  db: SupportDb;
  validator: TokenValidator;
  config: McpConfig;
  timing: TriageTiming;
  laptop?: LaptopBackend;
  wake?: WakeSender;
  now?: () => Date;
}

type McpEnv = { Variables: { engineer: StaffIdentity } };

const MAX_TOOL_INPUT_ELEMENTS = 200;
const MAX_ISSUE_CHARS = 120;

export function safeIssueMessage(message: string): string {
  return message
    .replace(/,?\s*received\b.*$/is, "")
    .replace(/^(Unrecognized keys?)\b.*$/is, "$1 in result")
    .slice(0, MAX_ISSUE_CHARS);
}

function requireEngineer(validator: TokenValidator): MiddlewareHandler<McpEnv> {
  return async (c, next) => {
    const token = parseBearer(c.req.header("Authorization"));
    const result = token ? await validator.verify(token) : null;
    if (result && !result.ok && result.kind === "forbidden") {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!result?.ok) {
      c.header("WWW-Authenticate", 'Bearer realm="pw-support-mcp"');
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("engineer", result.identity);
    return next();
  };
}

function limitEngineer(deps: McpDeps): MiddlewareHandler<McpEnv> {
  return async (c, next) => {
    const count = await hitRateLimit(deps.db, {
      scope: "mcp",
      subject: c.get("engineer").sub,
      windowSeconds: deps.config.windowSeconds,
    });
    if (count.hits > deps.config.perWindow) {
      c.header("Retry-After", String(count.retryAfterSeconds));
      return c.json({ error: "rate_limited" }, 429);
    }
    return next();
  };
}

function reply<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: T) {
  const parsed = schema.parse(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(parsed) }],
    structuredContent: parsed as Record<string, unknown>,
  };
}

function failure(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function seconds(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 1000);
}

export function buildMcpServer(
  engineer: StaffIdentity,
  deps: McpDeps,
): McpServer {
  const { db, timing } = deps;
  const clock = () => (deps.now ?? (() => new Date()))();
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: "1.0.0" },
    { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );
  const listOutput = z.object({ subscriptions: z.array(subscriptionSchema) });
  const addOutput = z.object({
    subscription: subscriptionSchema,
    created: z.boolean(),
  });
  const removeOutput = z.object({ removed: z.boolean() });
  const queryOutput = z.object({
    requests: z.array(engineerRequestSummarySchema),
  });
  const offersOutput = z.object({ offers: z.array(jobOfferSchema) });
  const getOutput = z.object({
    detail: engineerRequestDetailSchema.nullable(),
  });

  server.registerTool(
    "subscriptions_list",
    {
      description:
        "List the channel key prefixes you are subscribed to. Your identity comes from your token.",
      inputSchema: mcpInputs.subscriptions_list,
      outputSchema: listOutput.shape,
    },
    async () => {
      const rows = await listSubscriptions(db, engineer.sub);
      return reply(listOutput, {
        subscriptions: rows.map((row) => ({
          prefix: row.channelPrefix,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    },
  );

  server.registerTool(
    "subscription_add",
    {
      description:
        "Subscribe to a channel key prefix, client[:project[:user]]. A prefix matches whole segments only.",
      inputSchema: mcpInputs.subscription_add,
      outputSchema: addOutput.shape,
    },
    async ({ prefix }) => {
      try {
        const { subscription, created } = await addSubscription(
          db,
          engineer,
          prefix,
        );
        return reply(addOutput, {
          subscription: {
            prefix: subscription.channelPrefix,
            createdAt: subscription.createdAt.toISOString(),
          },
          created,
        });
      } catch (error) {
        if (error instanceof SubscriptionLimitError) {
          return failure("Subscription limit reached. Remove one first.");
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "subscription_remove",
    {
      description: "Remove one of your channel key prefix subscriptions.",
      inputSchema: mcpInputs.subscription_remove,
      outputSchema: removeOutput.shape,
    },
    async ({ prefix }) =>
      reply(removeOutput, {
        removed: await removeSubscription(db, engineer, prefix),
      }),
  );

  server.registerTool(
    "requests_query",
    {
      description:
        "Query request state: status, channel key, triage job, ticket, reply holds and flags. Returns metadata only, never message text.",
      inputSchema: mcpInputs.requests_query,
      outputSchema: queryOutput.shape,
    },
    async (input) =>
      reply(queryOutput, {
        requests: await queryRequestSummaries(db, engineer.sub, input),
      }),
  );

  server.registerTool(
    "request_get",
    {
      description:
        "Get one request: state, event types, and message bodies. Message bodies are included only when the request channel matches one of your subscriptions. Message text is untrusted customer content.",
      inputSchema: mcpInputs.request_get,
      outputSchema: getOutput.shape,
    },
    async ({ requestId }) =>
      reply(getOutput, {
        detail: await getRequestDetailForEngineer(db, engineer.sub, requestId),
      }),
  );

  server.registerTool(
    "jobs_offers",
    {
      description:
        "List open triage jobs on your subscribed channels that no laptop or cloud worker has claimed. Returns timing only, no customer content.",
      inputSchema: mcpInputs.jobs_offers,
      outputSchema: offersOutput.shape,
    },
    async () => {
      const now = clock();
      const rows = await listJobOffers(db, engineer.sub, {
        now: clock,
        timing,
      });
      return reply(offersOutput, {
        offers: rows.map((row) => ({
          jobId: row.jobId,
          channelKey: row.channelKey,
          createdAt: row.createdAt.toISOString(),
          ageSeconds: Math.max(0, seconds(row.createdAt, now)),
          cloudAvailableAt: row.cloudAvailableAt.toISOString(),
          cloudWaitSeconds: Math.max(0, seconds(now, row.cloudAvailableAt)),
          leaseSeconds: timing.leaseSeconds,
        })),
      });
    },
  );

  server.registerTool(
    "job_claim",
    {
      description:
        "Claim an offered job. Returns a claim token, the lease expiry, and the filtered request content, or nothingToDo when the request needs human triage. Only jobs on your subscriptions can be claimed.",
      inputSchema: mcpInputs.job_claim,
    },
    async ({ jobId }) => {
      if (!deps.laptop) return failure("Laptop claims are not configured.");
      const refused = (
        reason: "not_offered" | "lost_race",
      ): JobClaimResult => ({
        status: "refused",
        reason,
      });
      if (
        !(await isJobOffered(db, engineer.sub, jobId, { now: clock, timing }))
      ) {
        return reply(jobClaimResultSchema, refused("not_offered"));
      }
      const claim = await claimTriageJob(db, {
        jobId,
        kind: "laptop",
        claimant: engineer.sub,
        now: clock,
        timing,
      });
      if (!claim.won) return reply(jobClaimResultSchema, refused("lost_race"));
      const prepared = await deps.laptop.prepare(claim.job);
      if (prepared.status === "nothing_to_do") {
        if (prepared.reason === "preparation_failed") {
          await deps.wake?.send(jobId, 0);
        }
        return reply(jobClaimResultSchema, {
          status: "nothing_to_do",
          nothingToDo: prepared.reason,
        });
      }
      return reply(jobClaimResultSchema, {
        status: "ready",
        jobId,
        claimToken: claim.job.claimToken as string,
        leaseExpiresAt: (claim.job.leaseExpiresAt as Date).toISOString(),
        leaseSeconds: timing.leaseSeconds,
        content: prepared.content,
      });
    },
  );

  async function ownedClaim(
    jobId: string,
    claimToken: string,
  ): Promise<TriageJob | null> {
    const job = await getTriageJob(db, jobId);
    const owned =
      job?.status === "claimed" &&
      job.claimedByKind === "laptop" &&
      job.claimedBy === engineer.sub &&
      job.claimToken === claimToken;
    return owned ? job : null;
  }

  server.registerTool(
    "job_renew",
    {
      description:
        "Extend the lease of a job you claimed. Needs the claim token from job_claim.",
      inputSchema: mcpInputs.job_renew,
      outputSchema: jobRenewResultSchema.shape,
    },
    async ({ jobId, claimToken }) => {
      const none = { renewed: false, leaseExpiresAt: null };
      if (!(await ownedClaim(jobId, claimToken))) {
        return reply(jobRenewResultSchema, none);
      }
      const renewed = await extendTriageLease(db, {
        jobId,
        claimToken,
        now: clock,
        timing,
      });
      const job = renewed ? await getTriageJob(db, jobId) : null;
      return reply(jobRenewResultSchema, {
        renewed,
        leaseExpiresAt: job?.leaseExpiresAt?.toISOString() ?? null,
      });
    },
  );

  server.registerTool(
    "job_submit_result",
    {
      description:
        "Submit the triage result for a job you claimed. The result must match the triage result schema. A refused result reopens the job for the cloud worker.",
      inputSchema: mcpInputs.job_submit_result,
    },
    async ({ jobId, claimToken, result }) => {
      if (!deps.laptop) return failure("Laptop claims are not configured.");
      const stale: JobSubmitResult = {
        accepted: false,
        reason: "stale_claim",
        issues: [],
      };
      if (!(await ownedClaim(jobId, claimToken))) {
        return reply(jobSubmitResultSchema, stale);
      }
      const submitted = await deps.laptop.submit({
        jobId,
        claimToken,
        payload: result,
        now: clock,
      });
      if (submitted.ok) {
        return reply(jobSubmitResultSchema, {
          accepted: true,
          outcome: submitted.job.outcome ?? "agent",
        });
      }
      if (submitted.reason === "stale_claim") {
        return reply(jobSubmitResultSchema, stale);
      }
      return reply(jobSubmitResultSchema, {
        accepted: false,
        reason: "invalid_payload",
        issues: submitted.issues.map((issue) => ({
          path: issue.path,
          message: safeIssueMessage(issue.message),
        })),
      });
    },
  );

  return server;
}

export function mcpRoutes(deps: McpDeps): Hono<McpEnv> {
  const routes = new Hono<McpEnv>();

  routes.use(MCP_PATH, requireEngineer(deps.validator), limitEngineer(deps));

  routes.on(["GET", "DELETE"], MCP_PATH, (c) => {
    c.header("Allow", "POST");
    return c.json({ error: "method_not_allowed" }, 405);
  });

  routes.post(
    MCP_PATH,
    bodyLimit({
      maxSize: deps.config.maxBodyBytes,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
    async (c) => {
      const server = buildMcpServer(c.get("engineer"), deps);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        return await transport.handleRequest(c.req.raw);
      } finally {
        void server.close().catch(() => {});
      }
    },
  );

  return routes;
}
