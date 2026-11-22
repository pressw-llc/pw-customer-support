import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type JobClaimResult,
  type JobOffer,
  type JobSubmitResult,
  jobClaimResultSchema,
  jobOfferSchema,
  jobRenewResultSchema,
  jobSubmitResultSchema,
  MCP_LAPTOP_PATH,
  MCP_PATH,
  SUBMIT_HEADER,
  WATCHER_HEADER,
  WATCHER_PATH,
} from "@pw-support/contracts";
import { z } from "zod";
import type { WatcherCredential } from "./watcher-credential";

export interface SupportApi {
  offers(): Promise<JobOffer[]>;
  claim(jobId: string): Promise<JobClaimResult>;
  renew(jobId: string, claimToken: string): Promise<boolean>;
  submit(
    jobId: string,
    claimToken: string,
    result: unknown,
  ): Promise<JobSubmitResult>;
  close(): Promise<void>;
}

export class McpToolError extends Error {
  constructor(tool: string) {
    super(`tool ${tool} failed`);
    this.name = "McpToolError";
  }
}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("rate limited");
    this.name = "RateLimitedError";
  }
}

const DEFAULT_RETRY_AFTER_SECONDS = 30;

interface Endpoint {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

function createEndpoint(input: {
  url: string;
  clientName: string;
  headers: () => Promise<Record<string, string>>;
  fetcher?: typeof fetch;
}): Endpoint {
  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;
  let limited: number | null = null;

  const transportFetch = async (
    target: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(await input.headers())) {
      merged.set(name, value);
    }
    const response = await (input.fetcher ?? fetch)(target, {
      ...init,
      headers: merged,
    });
    if (response.status === 429) {
      const header = Number(response.headers.get("retry-after"));
      limited =
        Number.isFinite(header) && header > 0
          ? header
          : DEFAULT_RETRY_AFTER_SECONDS;
    }
    return response;
  };

  function connect(): Promise<Client> {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      const created = new Client({ name: input.clientName, version: "1.0.0" });
      try {
        await created.connect(
          new StreamableHTTPClientTransport(new URL(input.url), {
            fetch: transportFetch as typeof fetch,
          }),
        );
        client = created;
        return created;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  async function close(): Promise<void> {
    const current = client;
    client = null;
    await current?.close().catch(() => {});
  }

  return {
    close,
    async call(tool, args) {
      limited = null;
      try {
        const active = await connect();
        const result = (await active.callTool({
          name: tool,
          arguments: args,
        })) as {
          isError?: boolean;
          content: { type: string; text?: string }[];
        };
        if (result.isError) throw new McpToolError(tool);
        return JSON.parse(
          result.content.map((block) => block.text ?? "").join(""),
        );
      } catch (error) {
        if (!(error instanceof McpToolError)) await close();
        if (limited !== null) throw new RateLimitedError(limited);
        throw error;
      }
    },
  };
}

export interface SupportApiOptions {
  apiUrl: string;
  getToken: () => Promise<string>;
  watcher: WatcherCredential;
  fetcher?: typeof fetch;
}

export function createSupportApi(options: SupportApiOptions): SupportApi {
  const bearer = async () => ({
    Authorization: `Bearer ${await options.getToken()}`,
  });
  const state = createEndpoint({
    url: `${options.apiUrl}${MCP_PATH}`,
    clientName: "pw-support-plugin",
    headers: bearer,
    fetcher: options.fetcher,
  });
  const laptop = createEndpoint({
    url: `${options.apiUrl}${MCP_LAPTOP_PATH}`,
    clientName: "pw-support-plugin",
    headers: async () => ({
      ...(await bearer()),
      [WATCHER_HEADER]: `${options.watcher.machineId}.${options.watcher.secret}`,
    }),
    fetcher: options.fetcher,
  });
  return {
    async offers() {
      const parsed = z
        .object({ offers: z.array(jobOfferSchema) })
        .parse(await state.call("jobs_offers", {}));
      return parsed.offers;
    },
    async claim(jobId) {
      return jobClaimResultSchema.parse(
        await laptop.call("job_claim", { jobId }),
      );
    },
    async renew(jobId, claimToken) {
      return jobRenewResultSchema.parse(
        await laptop.call("job_renew", { jobId, claimToken }),
      ).renewed;
    },
    async submit(jobId, claimToken, result) {
      return jobSubmitResultSchema.parse(
        await laptop.call("job_submit_result", { jobId, claimToken, result }),
      );
    },
    async close() {
      await Promise.all([state.close(), laptop.close()]);
    },
  };
}

export function createSubmitApi(options: {
  apiUrl: string;
  submitToken: string;
  fetcher?: typeof fetch;
}): Pick<SupportApi, "submit" | "close"> {
  const laptop = createEndpoint({
    url: `${options.apiUrl}${MCP_LAPTOP_PATH}`,
    clientName: "pw-support-submit",
    headers: async () => ({ [SUBMIT_HEADER]: options.submitToken }),
    fetcher: options.fetcher,
  });
  return {
    async submit(jobId, claimToken, result) {
      return jobSubmitResultSchema.parse(
        await laptop.call("job_submit_result", { jobId, claimToken, result }),
      );
    },
    close: laptop.close,
  };
}

async function watcherRequest(
  input: {
    apiUrl: string;
    token: string;
    fetcher?: typeof fetch;
  },
  method: "PUT" | "DELETE",
  body: unknown,
): Promise<Response> {
  return (input.fetcher ?? fetch)(`${input.apiUrl}${WATCHER_PATH}`, {
    method,
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function registerWatcher(
  input: { apiUrl: string; token: string; fetcher?: typeof fetch },
  credential: WatcherCredential,
): Promise<void> {
  const response = await watcherRequest(input, "PUT", credential);
  if (!response.ok) {
    throw new Error(`watcher registration failed with ${response.status}`);
  }
}

export async function revokeWatcher(
  input: { apiUrl: string; token: string; fetcher?: typeof fetch },
  machineId: string,
): Promise<boolean> {
  const response = await watcherRequest(input, "DELETE", { machineId });
  return response.ok;
}
