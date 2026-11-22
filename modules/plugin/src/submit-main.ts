import { writeFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSubmitServer, SUBMIT_ENV } from "./submit-server";
import { createSupportApi } from "./support-api";

export async function runSubmitServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const read = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const jobId = read(SUBMIT_ENV.jobId);
  const claimToken = read(SUBMIT_ENV.claimToken);
  const accessToken = read(SUBMIT_ENV.accessToken);
  const outcomeFile = read(SUBMIT_ENV.outcomeFile);
  const api = createSupportApi({
    apiUrl: read(SUBMIT_ENV.apiUrl),
    getToken: async () => accessToken,
    clientName: "pw-support-submit",
  });
  const server = createSubmitServer({
    forward: (result) => api.submit(jobId, claimToken, result),
    onOutcome: (outcome) =>
      writeFileSync(outcomeFile, JSON.stringify(outcome), { mode: 0o600 }),
  });
  await server.connect(new StdioServerTransport());
}
