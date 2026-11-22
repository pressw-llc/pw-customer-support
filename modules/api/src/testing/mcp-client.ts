import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "@pw-support/contracts";

export interface ServedApp {
  url: string;
  stop(): void;
}

export function serveApp(app: {
  fetch: (request: Request) => Response | Promise<Response>;
}): ServedApp {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

export interface McpTestClient {
  tools(): Promise<string[]>;
  call<T = Record<string, unknown>>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<T>;
  callRaw(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError?: boolean; text: string }>;
  close(): Promise<void>;
}

export async function connectMcp(
  baseUrl: string,
  token: string,
): Promise<McpTestClient> {
  const client = new Client({ name: "pw-support-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}${MCP_PATH}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);

  async function callRaw(name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    return {
      isError: result.isError,
      text: result.content.map((block) => block.text ?? "").join(""),
    };
  }

  return {
    async tools() {
      return (await client.listTools()).tools.map((tool) => tool.name);
    },
    callRaw,
    async call<T>(name: string, args: Record<string, unknown> = {}) {
      const raw = await callRaw(name, args);
      if (raw.isError) throw new Error(raw.text);
      return JSON.parse(raw.text) as T;
    },
    close: () => client.close(),
  };
}

export async function postMcp(
  baseUrl: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}${MCP_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
