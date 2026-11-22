import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  MCP_LAPTOP_PATH,
  MCP_PATH,
  SUBMIT_HEADER,
  WATCHER_HEADER,
  WATCHER_PATH,
} from "@pw-support/contracts";
import { z } from "zod";
import {
  createSubmitApi,
  createSupportApi,
  McpToolError,
  RateLimitedError,
  registerWatcher,
  revokeWatcher,
} from "./support-api";

const JOB = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const watcher = {
  machineId: "33333333-3333-4333-8333-333333333333",
  secret: "W".repeat(43),
};

interface Seen {
  path: string;
  method: string;
  headers: Headers;
  rpc?: { method?: string };
}

function startServer(options: { limit?: boolean; broken?: boolean } = {}) {
  const seen: Seen[] = [];
  let connections = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const entry: Seen = {
        path: url.pathname,
        method: request.method,
        headers: request.headers,
      };
      seen.push(entry);
      if (url.pathname === WATCHER_PATH) {
        return Response.json(
          { ok: true },
          { status: options.broken ? 500 : 200 },
        );
      }
      const body = request.method === "POST" ? await request.json() : undefined;
      entry.rpc = body as Seen["rpc"];
      if (options.limit && entry.rpc?.method === "tools/call") {
        return new Response("{}", {
          status: 429,
          headers: { "Retry-After": "7" },
        });
      }
      const mcp = new McpServer({ name: "fake", version: "1" });
      if (entry.rpc?.method === "initialize") connections += 1;
      mcp.registerTool("jobs_offers", { inputSchema: {} }, async () => ({
        content: [{ type: "text", text: JSON.stringify({ offers: [] }) }],
      }));
      mcp.registerTool(
        "job_renew",
        { inputSchema: { jobId: z.string(), claimToken: z.string() } },
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({ renewed: true, leaseExpiresAt: null }),
            },
          ],
        }),
      );
      mcp.registerTool(
        "job_submit_result",
        {
          inputSchema: {
            jobId: z.string(),
            claimToken: z.string(),
            result: z.any(),
          },
        },
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({ accepted: true, outcome: "agent" }),
            },
          ],
        }),
      );
      mcp.registerTool(
        "job_claim",
        { inputSchema: { jobId: z.string() } },
        async () => ({
          isError: true,
          content: [{ type: "text", text: "no" }],
        }),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      return transport.handleRequest(request, { parsedBody: body });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    connections: () => connections,
    stop: () => server.stop(true),
  };
}

let active: { stop(): void } | undefined;
afterEach(() => active?.stop());

describe("support api client", () => {
  test("reuses one client per endpoint, refreshes the token on every request, and sends the watcher header only to the laptop endpoint", async () => {
    const server = startServer();
    active = server;
    let tokens = 0;
    const api = createSupportApi({
      apiUrl: server.url,
      getToken: async () => `token-${++tokens}`,
      watcher,
    });
    await api.offers();
    await api.offers();
    await api.offers();
    expect(await api.renew(JOB, TOKEN)).toBe(true);
    expect(await api.renew(JOB, TOKEN)).toBe(true);
    expect(server.connections()).toBe(2);
    const posts = server.seen.filter((entry) => entry.method === "POST");
    const state = posts.filter((entry) => entry.path === MCP_PATH);
    const laptop = posts.filter((entry) => entry.path === MCP_LAPTOP_PATH);
    expect(state.length).toBeGreaterThan(0);
    expect(laptop.length).toBeGreaterThan(0);
    for (const entry of state) {
      expect(entry.headers.get(WATCHER_HEADER)).toBeNull();
    }
    for (const entry of laptop) {
      expect(entry.headers.get(WATCHER_HEADER)).toBe(
        `${watcher.machineId}.${watcher.secret}`,
      );
    }
    const bearer = posts.map((entry) => entry.headers.get("authorization"));
    expect(new Set(bearer).size).toBe(bearer.length);
    await api.close();
  });

  test("a tool error does not drop the client, and a transport error reconnects", async () => {
    const server = startServer();
    active = server;
    const api = createSupportApi({
      apiUrl: server.url,
      getToken: async () => "t",
      watcher,
    });
    await expect(api.claim(JOB)).rejects.toBeInstanceOf(McpToolError);
    await api.renew(JOB, TOKEN);
    expect(server.connections()).toBe(1);
    server.stop();
    await expect(api.renew(JOB, TOKEN)).rejects.toThrow();
    const again = startServer();
    active = again;
    const fresh = createSupportApi({
      apiUrl: again.url,
      getToken: async () => "t",
      watcher,
    });
    expect(await fresh.renew(JOB, TOKEN)).toBe(true);
    await fresh.close();
  });

  test("surfaces a 429 with its Retry-After", async () => {
    const server = startServer({ limit: true });
    active = server;
    const api = createSupportApi({
      apiUrl: server.url,
      getToken: async () => "t",
      watcher,
    });
    const error = await api.offers().catch((caught) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(7);
    await api.close();
  });

  test("the submit api sends only the submit credential and never a bearer token", async () => {
    const server = startServer();
    active = server;
    const api = createSubmitApi({ apiUrl: server.url, submitToken: "SUBMIT" });
    const answer = await api.submit(JOB, TOKEN, { title: "t" });
    expect(answer).toEqual({ accepted: true, outcome: "agent" });
    for (const entry of server.seen) {
      expect(entry.path).toBe(MCP_LAPTOP_PATH);
      expect(entry.headers.get(SUBMIT_HEADER)).toBe("SUBMIT");
      expect(entry.headers.get("authorization")).toBeNull();
      expect(entry.headers.get(WATCHER_HEADER)).toBeNull();
    }
    await api.close();
  });

  test("registers and revokes the watcher over plain requests", async () => {
    const server = startServer();
    active = server;
    await registerWatcher({ apiUrl: server.url, token: "tok" }, watcher);
    expect(
      await revokeWatcher(
        { apiUrl: server.url, token: "tok" },
        watcher.machineId,
      ),
    ).toBe(true);
    expect(server.seen.map((entry) => entry.method)).toEqual(["PUT", "DELETE"]);
    expect(server.seen[0]?.headers.get("authorization")).toBe("Bearer tok");
    const broken = startServer({ broken: true });
    active = broken;
    await expect(
      registerWatcher({ apiUrl: broken.url, token: "tok" }, watcher),
    ).rejects.toThrow("500");
    expect(
      await revokeWatcher(
        { apiUrl: broken.url, token: "tok" },
        watcher.machineId,
      ),
    ).toBe(false);
  });
});
