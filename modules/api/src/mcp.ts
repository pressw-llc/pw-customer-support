import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  interactiveToolOutputs,
  MCP_PATH,
  mcpInputs,
  type StaffIdentity,
} from "@pw-support/contracts";
import {
  addSubscription,
  getRequestDetailForEngineer,
  listJobOffers,
  listSubscriptions,
  queryRequestSummaries,
  removeSubscription,
  SubscriptionLimitError,
} from "@pw-support/db";
import { Hono } from "hono";
import { laptopRoutes, watcherRoutes } from "./mcp-laptop";
import {
  bodyCap,
  failure,
  limitToolCalls,
  type McpDeps,
  type McpEnv,
  methodNotAllowed,
  newMcpServer,
  parseRpcBody,
  reply,
  requireEngineer,
  seconds,
  serve,
} from "./mcp-shared";

export {
  type LaptopBackend,
  type McpConfig,
  type McpDeps,
  safeIssueMessage,
} from "./mcp-shared";

const CONTENT_NOTE =
  "Customer message text is never returned here. Read it in the admin UI.";

export function buildMcpServer(
  engineer: StaffIdentity,
  deps: McpDeps,
): McpServer {
  const { db, timing } = deps;
  const clock = () => (deps.now ?? (() => new Date()))();
  const server = newMcpServer();
  const out = interactiveToolOutputs;

  server.registerTool(
    "subscriptions_list",
    {
      description:
        "List the channel key prefixes you are subscribed to. Your identity comes from your token.",
      inputSchema: mcpInputs.subscriptions_list,
      outputSchema: out.subscriptions_list.shape,
    },
    async () => {
      const rows = await listSubscriptions(db, engineer.sub);
      return reply(out.subscriptions_list, {
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
      outputSchema: out.subscription_add.shape,
    },
    async ({ prefix }) => {
      try {
        const { subscription, created } = await addSubscription(
          db,
          engineer,
          prefix,
        );
        return reply(out.subscription_add, {
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
      outputSchema: out.subscription_remove.shape,
    },
    async ({ prefix }) =>
      reply(out.subscription_remove, {
        removed: await removeSubscription(db, engineer, prefix),
      }),
  );

  server.registerTool(
    "requests_query",
    {
      description: `Query request state: status, channel key, triage job, ticket identifier and link, reply holds and flags. State only. ${CONTENT_NOTE}`,
      inputSchema: mcpInputs.requests_query,
      outputSchema: out.requests_query.shape,
    },
    async (input) =>
      reply(out.requests_query, {
        requests: await queryRequestSummaries(db, engineer.sub, input),
      }),
  );

  server.registerTool(
    "request_get",
    {
      description: `Get one request: state, event types, message, attachment, and character counts, and reply hold and flag states with wording scores. State only. ${CONTENT_NOTE}`,
      inputSchema: mcpInputs.request_get,
      outputSchema: out.request_get.shape,
    },
    async ({ requestId }) =>
      reply(out.request_get, {
        detail: await getRequestDetailForEngineer(db, engineer.sub, requestId),
      }),
  );

  server.registerTool(
    "jobs_offers",
    {
      description:
        "List open triage jobs on your subscribed channels that no laptop or cloud worker has claimed. Returns timing only, no customer content.",
      inputSchema: mcpInputs.jobs_offers,
      outputSchema: out.jobs_offers.shape,
    },
    async () => {
      const now = clock();
      const rows = await listJobOffers(db, engineer.sub, {
        now: clock,
        timing,
      });
      return reply(out.jobs_offers, {
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

  return server;
}

export function mcpRoutes(deps: McpDeps): Hono<McpEnv> {
  const routes = new Hono<McpEnv>();

  routes.use(MCP_PATH, requireEngineer(deps.validator));
  routes.on(["GET", "DELETE"], MCP_PATH, methodNotAllowed());
  routes.post(
    MCP_PATH,
    bodyCap(deps),
    parseRpcBody(),
    limitToolCalls(deps),
    (c) =>
      serve(
        buildMcpServer(c.get("engineer"), deps),
        c.req.raw,
        c.get("rpcBody"),
      ),
  );

  routes.route("/", watcherRoutes(deps));
  routes.route("/", laptopRoutes(deps));
  return routes;
}
