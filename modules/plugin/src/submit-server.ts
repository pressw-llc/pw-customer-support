import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type JobSubmitResult,
  SUBMIT_RESULT_TOOL,
  TRIAGE_LIMITS,
  triageCategories,
  triageLabels,
  triagePriorities,
} from "@pw-support/contracts";
import { z } from "zod";

export const SUBMIT_SERVER_NAME = "pw_submit";

export const SUBMIT_TOOL_FULL_NAME = `mcp__${SUBMIT_SERVER_NAME}__${SUBMIT_RESULT_TOOL}`;

export type SubmitOutcome =
  | { accepted: true }
  | {
      accepted: false;
      reason: "stale_claim" | "invalid_payload" | "transport";
    };

export interface SubmitServerOptions {
  forward: (result: unknown) => Promise<JobSubmitResult>;
  onOutcome: (outcome: SubmitOutcome) => void;
}

const DESCRIPTION = [
  "Submit the triage result for the request. Call this tool exactly once.",
  `Keys: title (max ${TRIAGE_LIMITS.titleMax} chars), summary (max ${TRIAGE_LIMITS.summaryMax} chars),`,
  `category (${triageCategories.join("|")}), priority (${triagePriorities.join("|")}),`,
  `labels (max ${TRIAGE_LIMITS.labelsMax} of ${triageLabels.join("|")}), needs_human (boolean).`,
].join(" ");

const loose = (type: z.ZodTypeAny, description: string) =>
  z.union([type, z.any()]).describe(description);

const INPUT = z
  .object({
    title: loose(z.string(), `string, max ${TRIAGE_LIMITS.titleMax} chars`),
    summary: loose(z.string(), `string, max ${TRIAGE_LIMITS.summaryMax} chars`),
    category: loose(z.string(), `one of ${triageCategories.join(", ")}`),
    priority: loose(z.string(), `one of ${triagePriorities.join(", ")}`),
    labels: loose(
      z.array(z.string()),
      `JSON array of at most ${TRIAGE_LIMITS.labelsMax} values from ${triageLabels.join(", ")}, empty array when none`,
    ),
    needs_human: loose(z.boolean(), "JSON boolean true or false"),
  })
  .passthrough();

export function createSubmitServer(options: SubmitServerOptions): McpServer {
  const server = new McpServer({ name: SUBMIT_SERVER_NAME, version: "1.0.0" });
  let used = false;
  server.registerTool(
    SUBMIT_RESULT_TOOL,
    {
      description: DESCRIPTION,
      inputSchema: INPUT,
    },
    async (args) => {
      if (used) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: "A result was already submitted." },
          ],
        };
      }
      used = true;
      let outcome: SubmitOutcome;
      try {
        const answer = await options.forward(args);
        outcome = answer.accepted
          ? { accepted: true }
          : { accepted: false, reason: answer.reason };
      } catch {
        outcome = { accepted: false, reason: "transport" };
      }
      options.onOutcome(outcome);
      return {
        content: [
          {
            type: "text" as const,
            text: outcome.accepted
              ? "Result accepted. Stop now."
              : "Result refused. Stop now.",
          },
        ],
      };
    },
  );
  return server;
}

export const SUBMIT_ENV = {
  jobId: "PW_SUPPORT_JOB_ID",
  claimToken: "PW_SUPPORT_CLAIM_TOKEN",
  accessToken: "PW_SUPPORT_ACCESS_TOKEN",
  outcomeFile: "PW_SUPPORT_OUTCOME_FILE",
  apiUrl: "PW_SUPPORT_API_URL",
} as const;
