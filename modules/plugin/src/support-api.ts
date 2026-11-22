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
  MCP_PATH,
} from "@pw-support/contracts";
import { z } from "zod";

export interface SupportApi {
  offers(): Promise<JobOffer[]>;
  claim(jobId: string): Promise<JobClaimResult>;
  renew(jobId: string, claimToken: string): Promise<boolean>;
  submit(
    jobId: string,
    claimToken: string,
    result: unknown,
  ): Promise<JobSubmitResult>;
}

export interface SupportApiOptions {
  apiUrl: string;
  getToken: () => Promise<string>;
  clientName?: string;
}

export class McpToolError extends Error {
  constructor(tool: string) {
    super(`tool ${tool} failed`);
    this.name = "McpToolError";
  }
}

export function createSupportApi(options: SupportApiOptions): SupportApi {
  async function call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const token = await options.getToken();
    const client = new Client({
      name: options.clientName ?? "pw-support-plugin",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${options.apiUrl}${MCP_PATH}`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    try {
      await client.connect(transport);
      const result = (await client.callTool({
        name: tool,
        arguments: args,
      })) as {
        isError?: boolean;
        content: { type: string; text?: string }[];
      };
      if (result.isError) throw new McpToolError(tool);
      const text = result.content.map((block) => block.text ?? "").join("");
      return JSON.parse(text);
    } finally {
      await client.close().catch(() => {});
    }
  }

  return {
    async offers() {
      const parsed = z
        .object({ offers: z.array(jobOfferSchema) })
        .parse(await call("jobs_offers", {}));
      return parsed.offers;
    },
    async claim(jobId) {
      return jobClaimResultSchema.parse(await call("job_claim", { jobId }));
    },
    async renew(jobId, claimToken) {
      return jobRenewResultSchema.parse(
        await call("job_renew", { jobId, claimToken }),
      ).renewed;
    },
    async submit(jobId, claimToken, result) {
      return jobSubmitResultSchema.parse(
        await call("job_submit_result", { jobId, claimToken, result }),
      );
    },
  };
}
