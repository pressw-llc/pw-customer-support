import {
  archiveTicket,
  linearReadback,
  runSmoke,
  SmokeError,
} from "./smoke/lib";

const LINEAR_URL = "https://api.linear.app/graphql";

function option(name: string, env?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  const flag = at >= 0 ? process.argv[at + 1] : undefined;
  return flag ?? (env ? process.env[env] : undefined);
}

const apiUrl = option("api-url", "SMOKE_API_URL");
const projectKey = option("project-key", "SMOKE_PROJECT_KEY");
const apiKey = option("linear-key", "SMOKE_LINEAR_API_KEY");
const linearUrl = option("linear-url", "SMOKE_LINEAR_URL") ?? LINEAR_URL;
const keep = process.argv.includes("--keep");

const missing = [
  ["--api-url or SMOKE_API_URL", apiUrl],
  ["--project-key or SMOKE_PROJECT_KEY", projectKey],
  ["--linear-key or SMOKE_LINEAR_API_KEY", apiKey],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length > 0) {
  console.error(`[smoke] missing ${missing.join(", ")}`);
  process.exit(2);
}

try {
  const result = await runSmoke({
    apiUrl: apiUrl as string,
    projectKey: projectKey as string,
    readback: linearReadback({ url: linearUrl, apiKey: apiKey as string }),
  });
  console.log(
    `[smoke] PASS request ${result.requestId ?? "?"} became ${result.ticket.identifier} ${result.ticket.url}`,
  );
  if (!keep) {
    const archived = await archiveTicket({
      url: linearUrl,
      apiKey: apiKey as string,
      ticketId: result.ticket.id,
    }).catch(() => false);
    console.log(`[smoke] ticket ${archived ? "archived" : "left open"}`);
  }
} catch (error) {
  const step = error instanceof SmokeError ? error.step : "unknown";
  console.error(
    `[smoke] FAIL at ${step}: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
