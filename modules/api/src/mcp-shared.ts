import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type LaptopPrepared,
  MCP_SERVER_NAME,
  type StaffIdentity,
  type TriageTiming,
  type WakeSender,
} from "@pw-support/contracts";
import {
  hitRateLimit,
  type SubmitInput,
  type SubmitResult,
  type SupportDb,
  type TriageJob,
} from "@pw-support/db";
import type { Handler, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
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
  disabled?: boolean;
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

export type LaptopScope =
  | { kind: "engineer"; engineer: StaffIdentity }
  | { kind: "submit"; job: TriageJob };

export type McpEnv = {
  Variables: {
    engineer: StaffIdentity;
    rpcBody: unknown;
    subject: string;
    scope: LaptopScope;
  };
};

const MAX_TOOL_INPUT_ELEMENTS = 200;
const MAX_ISSUE_CHARS = 120;
const LEASE_TOOLS = new Set(["job_renew", "job_submit_result"]);
export const LEASE_CALLS_PER_WINDOW = 60;

export function safeIssueMessage(message: string): string {
  return message
    .replace(/,?\s*received\b.*$/is, "")
    .replace(/^(Unrecognized keys?)\b.*$/is, "$1 in result")
    .slice(0, MAX_ISSUE_CHARS);
}

export function requireEngineer(
  validator: TokenValidator,
): MiddlewareHandler<McpEnv> {
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
    c.set("subject", result.identity.sub);
    return next();
  };
}

export function toolCallNames(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const { method, params } = message as {
      method?: unknown;
      params?: { name?: unknown };
    };
    if (method !== "tools/call") return [];
    return [typeof params?.name === "string" ? params.name : ""];
  });
}

export function parseRpcBody(): MiddlewareHandler<McpEnv> {
  return async (c, next) => {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    c.set("rpcBody", body);
    return next();
  };
}

export async function overLimit(
  deps: McpDeps,
  subject: string,
  body: unknown,
): Promise<number | null> {
  const names = toolCallNames(body);
  const heavy = names.filter((name) => !LEASE_TOOLS.has(name)).length;
  const lease = names.length - heavy;
  const buckets: { scope: string; count: number; limit: number }[] = [
    { scope: "mcp", count: heavy, limit: deps.config.perWindow },
    { scope: "mcp_lease", count: lease, limit: LEASE_CALLS_PER_WINDOW },
  ];
  for (const { scope, count, limit } of buckets) {
    for (let index = 0; index < count; index++) {
      const hit = await hitRateLimit(deps.db, {
        scope,
        subject,
        windowSeconds: deps.config.windowSeconds,
      });
      if (hit.hits > limit) return hit.retryAfterSeconds;
    }
  }
  return null;
}

export function limitToolCalls(deps: McpDeps): MiddlewareHandler<McpEnv> {
  return async (c, next) => {
    const retry = await overLimit(deps, c.get("subject"), c.get("rpcBody"));
    if (retry !== null) {
      c.header("Retry-After", String(retry));
      return c.json({ error: "rate_limited" }, 429);
    }
    return next();
  };
}

export function bodyCap(deps: McpDeps): MiddlewareHandler<McpEnv> {
  return bodyLimit({
    maxSize: deps.config.maxBodyBytes,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  });
}

export function reply<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: T,
) {
  const parsed = schema.parse(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(parsed) }],
    structuredContent: parsed as Record<string, unknown>,
  };
}

export function failure(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function seconds(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 1000);
}

export function newMcpServer(): McpServer {
  return new McpServer(
    { name: MCP_SERVER_NAME, version: "1.0.0" },
    { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS },
  );
}

export async function serve(
  server: McpServer,
  request: Request,
  body: unknown,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    void server.close().catch(() => {});
  }
}

export function methodNotAllowed(): Handler<McpEnv> {
  return (c) => {
    c.header("Allow", "POST");
    return c.json({ error: "method_not_allowed" }, 405);
  };
}
