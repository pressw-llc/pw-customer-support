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
      reason:
        | "stale_claim"
        | "invalid_payload"
        | "transport"
        | "unknown_after_transport_error";
    };

export const submitConfigSchema = z.object({
  jobId: z.string().uuid(),
  claimToken: z.string().uuid(),
  submitToken: z.string().min(32),
  apiUrl: z.string().url(),
  outcomeFile: z.string().min(1),
});
export type SubmitConfig = z.infer<typeof submitConfigSchema>;

export interface SubmitServerOptions {
  forward: (result: unknown) => Promise<JobSubmitResult>;
  onOutcome: (outcome: SubmitOutcome) => void;
}

const DESCRIPTION = [
  "Submit the triage result for the request. Call this tool exactly once.",
  `Keys: title (max ${TRIAGE_LIMITS.titleMax} chars), summary (max ${TRIAGE_LIMITS.summaryMax} chars),`,
  `category (${triageCategories.join("|")}), priority (${triagePriorities.join("|")}),`,
  `labels (max ${TRIAGE_LIMITS.labelsMax} of ${triageLabels.join("|")}), needs_human (boolean).`,
  "The server validates every key and refuses a result that does not match.",
].join(" ");

const permissive = (description: string) => z.any().describe(description);

const INPUT = z
  .object({
    title: permissive(`string, max ${TRIAGE_LIMITS.titleMax} chars`),
    summary: permissive(`string, max ${TRIAGE_LIMITS.summaryMax} chars`),
    category: permissive(`one of ${triageCategories.join(", ")}`),
    priority: permissive(`one of ${triagePriorities.join(", ")}`),
    labels: permissive(
      `JSON array of at most ${TRIAGE_LIMITS.labelsMax} values from ${triageLabels.join(", ")}, empty array when none`,
    ),
    needs_human: permissive("JSON boolean true or false"),
  })
  .passthrough();

export function createSubmitServer(options: SubmitServerOptions): McpServer {
  const server = new McpServer({ name: SUBMIT_SERVER_NAME, version: "1.0.0" });
  let used = false;
  let uncertain = false;
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
        if (answer.accepted) {
          outcome = { accepted: true };
        } else if (uncertain && answer.reason === "stale_claim") {
          outcome = {
            accepted: false,
            reason: "unknown_after_transport_error",
          };
        } else {
          outcome = { accepted: false, reason: answer.reason };
        }
      } catch {
        if (uncertain) {
          outcome = {
            accepted: false,
            reason: "unknown_after_transport_error",
          };
        } else {
          uncertain = true;
          used = false;
          outcome = { accepted: false, reason: "transport" };
        }
      }
      options.onOutcome(outcome);
      return {
        content: [
          {
            type: "text" as const,
            text: outcome.accepted
              ? "Result accepted. Stop now."
              : outcome.reason === "transport"
                ? "The result could not be delivered. Call the tool once more."
                : outcome.reason === "unknown_after_transport_error"
                  ? "The result may or may not have been delivered. Stop now."
                  : "Result refused. Stop now.",
          },
        ],
      };
    },
  );
  return server;
}
