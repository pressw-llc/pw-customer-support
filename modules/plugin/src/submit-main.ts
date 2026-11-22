import { readFileSync, writeFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSubmitServer, submitConfigSchema } from "./submit-server";
import { createSubmitApi } from "./support-api";

export function readSubmitConfig(path: string) {
  return submitConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export async function runSubmitServerFromFile(path: string): Promise<void> {
  const config = readSubmitConfig(path);
  const api = createSubmitApi({
    apiUrl: config.apiUrl,
    submitToken: config.submitToken,
  });
  const server = createSubmitServer({
    forward: (result) => api.submit(config.jobId, config.claimToken, result),
    onOutcome: (outcome) =>
      writeFileSync(config.outcomeFile, JSON.stringify(outcome), {
        mode: 0o600,
      }),
  });
  await server.connect(new StdioServerTransport());
}
