import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type JobClaimResult,
  type JobSubmitResult,
  jobClaimResultSchema,
  jobRenewResultSchema,
  jobStatusResultSchema,
  jobSubmitResultSchema,
  MCP_LAPTOP_PATH,
  mcpInputs,
  SUBMIT_HEADER,
  WATCHER_HEADER,
  WATCHER_PATH,
  watcherRegistrationSchema,
  watcherRevocationSchema,
} from "@pw-support/contracts";
import {
  claimTriageJob,
  extendTriageLease,
  findJobBySubmitCredential,
  getTriageJob,
  hitRateLimit,
  isJobOffered,
  isWatcherValid,
  registerWatcher,
  releaseTriageJob,
  revokeWatcher,
  setSubmitCredential,
  type TriageJob,
} from "@pw-support/db";
import { type Handler, Hono, type MiddlewareHandler } from "hono";
import {
  bodyCap,
  failure,
  type LaptopScope,
  limitToolCalls,
  type McpDeps,
  type McpEnv,
  methodNotAllowed,
  newMcpServer,
  parseRpcBody,
  reply,
  requireEngineer,
  safeIssueMessage,
  serve,
} from "./mcp-shared";

type LaptopEnv = McpEnv;

const WATCHER_VALUE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const REGISTRATIONS_PER_WINDOW = 20;
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function newSubmitSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function buildLaptopServer(
  scope: LaptopScope,
  deps: McpDeps,
): McpServer {
  const { db, timing } = deps;
  const clock = () => (deps.now ?? (() => new Date()))();
  const server = newMcpServer();
  const actor = scope.kind === "engineer" ? scope.engineer.sub : null;

  async function ownedClaim(
    jobId: string,
    claimToken: string,
  ): Promise<TriageJob | null> {
    if (scope.kind === "submit" && scope.job.id !== jobId) return null;
    const job = await getTriageJob(db, jobId);
    const claimant = scope.kind === "submit" ? scope.job.claimedBy : actor;
    const owned =
      job?.status === "claimed" &&
      job.claimedByKind === "laptop" &&
      job.claimedBy === claimant &&
      job.claimToken === claimToken;
    return owned ? job : null;
  }

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

  if (scope.kind !== "engineer") return server;
  const engineer = scope.engineer;

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
    "job_status",
    {
      description:
        "Report whether a job you claimed is still claimed, completed, or no longer held. State only.",
      inputSchema: mcpInputs.job_status,
      outputSchema: jobStatusResultSchema.shape,
    },
    async ({ jobId, claimToken }) => {
      const job = await getTriageJob(db, jobId);
      const mine =
        job?.claimedByKind === "laptop" &&
        job.claimedBy === engineer.sub &&
        job.claimToken === claimToken;
      const state =
        mine && job?.status === "completed"
          ? "completed"
          : mine && job?.status === "claimed"
            ? "claimed"
            : "not_held";
      return reply(jobStatusResultSchema, {
        state,
        outcome: state === "completed" ? (job?.outcome ?? null) : null,
      });
    },
  );

  server.registerTool(
    "job_claim",
    {
      description:
        "Claim an offered job. Returns a claim token, a submit credential, the lease expiry, and the filtered request content, or nothingToDo when the request needs human triage. Only jobs on your subscriptions can be claimed.",
      inputSchema: mcpInputs.job_claim,
    },
    async ({ jobId }) => {
      if (!deps.laptop) return failure("Laptop claims are not configured.");
      const refused = (
        reason: "not_offered" | "lost_race",
      ): JobClaimResult => ({ status: "refused", reason });
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
      const claimToken = claim.job.claimToken as string;
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
      const leaseLost = async () => {
        await releaseTriageJob(db, {
          jobId,
          claimToken,
          reason: "lease_lost",
          now: clock,
        });
        await deps.wake?.send(jobId, 0);
        return reply(jobClaimResultSchema, {
          status: "nothing_to_do",
          nothingToDo: "lease_lost",
        });
      };
      const extended = await extendTriageLease(db, {
        jobId,
        claimToken,
        now: clock,
        timing,
      });
      if (!extended) return await leaseLost();
      const submitToken = newSubmitSecret();
      const stored = await setSubmitCredential(db, {
        jobId,
        claimToken,
        secret: submitToken,
        now: clock,
      });
      const held = stored ? await getTriageJob(db, jobId) : null;
      if (!held?.leaseExpiresAt || held.claimToken !== claimToken) {
        return await leaseLost();
      }
      return reply(jobClaimResultSchema, {
        status: "ready",
        jobId,
        claimToken,
        submitToken,
        leaseExpiresAt: held.leaseExpiresAt.toISOString(),
        leaseSeconds: timing.leaseSeconds,
        content: prepared.content,
      });
    },
  );

  return server;
}

function submitOrEngineer(deps: McpDeps): MiddlewareHandler<McpEnv> {
  const clock = () => (deps.now ?? (() => new Date()))();
  const engineerAuth = requireEngineer(deps.validator);
  return async (c, next) => {
    const submit = c.req.header(SUBMIT_HEADER);
    if (!submit) return engineerAuth(c, next);
    if (!SECRET_SHAPE.test(submit)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const job = await findJobBySubmitCredential(deps.db, {
      secret: submit,
      now: clock,
    });
    if (!job) return c.json({ error: "unauthorized" }, 401);
    c.set("scope", { kind: "submit", job });
    c.set("subject", job.id);
    return next();
  };
}

function requireWatcher(deps: McpDeps): MiddlewareHandler<McpEnv> {
  return async (c, next) => {
    if (c.get("scope")) return next();
    const engineer = c.get("engineer");
    const header = c.req.header(WATCHER_HEADER);
    if (!header) return c.json({ error: "watcher_required" }, 401);
    const match = WATCHER_VALUE.exec(header);
    if (!match?.[1] || !match[2]) return c.json({ error: "unauthorized" }, 401);
    const valid = await isWatcherValid(deps.db, {
      engineerSub: engineer.sub,
      machineId: match[1],
      secret: match[2],
    });
    if (!valid) return c.json({ error: "forbidden" }, 403);
    c.set("scope", { kind: "engineer", engineer });
    return next();
  };
}

export function laptopRoutes(deps: McpDeps): Hono<LaptopEnv> {
  const routes = new Hono<LaptopEnv>();
  routes.use(MCP_LAPTOP_PATH, submitOrEngineer(deps), requireWatcher(deps));
  routes.on(["GET", "DELETE"], MCP_LAPTOP_PATH, methodNotAllowed());
  routes.post(
    MCP_LAPTOP_PATH,
    bodyCap(deps),
    parseRpcBody(),
    limitToolCalls(deps),
    (c) =>
      serve(
        buildLaptopServer(c.get("scope"), deps),
        c.req.raw,
        c.get("rpcBody"),
      ),
  );
  return routes;
}

export function watcherRoutes(deps: McpDeps): Hono<McpEnv> {
  const routes = new Hono<McpEnv>();
  routes.use(WATCHER_PATH, requireEngineer(deps.validator));
  routes.on(["PUT", "DELETE"], WATCHER_PATH, bodyCap(deps), parseRpcBody());
  routes.put(WATCHER_PATH, async (c) => {
    const hit = await hitRateLimit(deps.db, {
      scope: "watcher_register",
      subject: c.get("engineer").sub,
      windowSeconds: deps.config.windowSeconds,
    });
    if (hit.hits > REGISTRATIONS_PER_WINDOW) {
      c.header("Retry-After", String(hit.retryAfterSeconds));
      return c.json({ error: "rate_limited" }, 429);
    }
    const parsed = watcherRegistrationSchema.safeParse(c.get("rpcBody"));
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    await registerWatcher(deps.db, {
      engineerSub: c.get("engineer").sub,
      ...parsed.data,
    });
    return c.json({ registered: true });
  });
  routes.delete(WATCHER_PATH, async (c) => {
    const parsed = watcherRevocationSchema.safeParse(c.get("rpcBody"));
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    const revoked = await revokeWatcher(deps.db, {
      engineerSub: c.get("engineer").sub,
      machineId: parsed.data.machineId,
    });
    return c.json({ revoked });
  });
  routes.all(WATCHER_PATH, methodNotAllowedWatcher());
  return routes;
}

function methodNotAllowedWatcher(): Handler<McpEnv> {
  return (c) => {
    c.header("Allow", "PUT, DELETE");
    return c.json({ error: "method_not_allowed" }, 405);
  };
}
