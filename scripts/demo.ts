import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_STUB_TEAMS } from "@pw-support/channels/testing";
import { resolveStackEnv } from "@pw-support/contracts";
import {
  closeDb,
  createDb,
  ensureProject,
  setProjectLinearTeam,
} from "@pw-support/db";
import {
  commentRequest,
  DEMO_CLIENT,
  DEMO_EMAIL,
  DEMO_KEY,
  DEMO_PROJECT,
  DEMO_WEBHOOK_SECRET,
  type DemoPorts,
  type DemoState,
  degradedNotes,
  demoUrls,
  isAlive,
  parseState,
  walkthrough,
} from "./demo/lib";
import { freePort } from "./validate/free-port";
import { exec, waitFor } from "./validate/steps";

const root = join(import.meta.dir, "..");
const demoDir = join(root, ".demo");
const stateFile = join(demoDir, "state.json");
const logDir = join(demoDir, "logs");

function readState(): DemoState | undefined {
  return existsSync(stateFile)
    ? parseState(readFileSync(stateFile, "utf8"))
    : undefined;
}

function launch(
  name: string,
  command: string[],
  cwd: string,
  env: Record<string, string>,
): number {
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, `${name}.log`), "a");
  const child = spawn(command[0] as string, command.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  return child.pid as number;
}

async function ready(url: string, what: string): Promise<void> {
  await waitFor(async () => (await fetch(url)).ok, `${what} at ${url}`, 90_000);
}

async function step(title: string, command: string[]): Promise<void> {
  console.log(`[demo] ${title}`);
  const result = await exec(command, { cwd: root });
  if (result.code !== 0) {
    console.error(result.out.slice(-1500));
    console.error(`[demo] FAIL ${title}`);
    process.exit(1);
  }
}

async function stackWasRunning(): Promise<boolean> {
  const result = await exec(["docker", "compose", "ps", "-q"], { cwd: root });
  return result.out.trim().length > 0;
}

async function start(): Promise<void> {
  const existing = readState();
  if (existing && Object.values(existing.pids).some((pid) => isAlive(pid))) {
    console.log("[demo] already running; use bun run demo stop first");
    printSummary(existing.ports);
    return;
  }

  const startedStack = !(await stackWasRunning());
  await step("start the local stack", ["bun", "scripts/stack.ts", "up"]);
  await step("migrate", ["bun", "scripts/db-migrate.ts"]);
  await step("create the bucket and queues", ["bun", "scripts/stack-setup.ts"]);
  await step("build the widget", [
    "bun",
    "run",
    "--filter",
    "@pressw-llc/support-react",
    "build",
  ]);

  console.log("[demo] seed the demo project");
  const db = createDb();
  await ensureProject(db, {
    clientSlug: DEMO_CLIENT,
    projectSlug: DEMO_PROJECT,
    name: `${DEMO_CLIENT} ${DEMO_PROJECT}`,
    key: DEMO_KEY,
  });
  await setProjectLinearTeam(db, {
    clientSlug: DEMO_CLIENT,
    projectSlug: DEMO_PROJECT,
    linearTeamId: DEFAULT_STUB_TEAMS[0]?.id ?? null,
  });
  await closeDb(db);

  const ports: DemoPorts = {
    api: freePort(),
    stub: freePort(),
    viewer: freePort(),
    admin: freePort(),
    host: freePort(),
  };
  const urls = demoUrls(ports, resolveStackEnv(process.env).oidcPort);
  const backend = {
    API_PORT: String(ports.api),
    LINEAR_API_URL: `http://127.0.0.1:${ports.stub}/graphql`,
    LINEAR_API_KEY: "demo-stub-key",
    LINEAR_WEBHOOK_SECRET: DEMO_WEBHOOK_SECRET,
    ADMIN_ORIGINS: urls.admin,
    TRIAGE_INITIAL_DELAY_SECONDS: "2",
    TRIAGE_SWEEP_INTERVAL_SECONDS: "3",
    TRIAGE_INTAKE_GRACE_SECONDS: "5",
    RATE_LIMIT_PER_USER: "5000",
    RATE_LIMIT_PER_KEY: "50000",
  };

  console.log("[demo] start the processes");
  const pids: Record<string, number> = {
    stub: launch("stub", ["bun", "scripts/demo/stub-server.ts"], root, {
      DEMO_STUB_PORT: String(ports.stub),
      DEMO_VIEWER_PORT: String(ports.viewer),
      DEMO_API_PORT: String(ports.api),
      LINEAR_WEBHOOK_SECRET: DEMO_WEBHOOK_SECRET,
    }),
    api: launch("api", ["bun", "apps/server/src/server.ts"], root, backend),
    worker: launch(
      "worker",
      ["bun", "pipelines/support-triage/fargate-entries/main.ts"],
      root,
      backend,
    ),
    admin: launch("admin", ["bunx", "vite"], join(root, "modules/admin"), {
      ADMIN_DEV_PORT: String(ports.admin),
      VITE_API_URL: urls.api,
      VITE_OIDC_AUTHORITY: urls.issuer,
      VITE_OIDC_CLIENT_ID: "pw-support-admin",
    }),
    host: launch(
      "host",
      [
        "bunx",
        "vite",
        "--host",
        "127.0.0.1",
        "--port",
        String(ports.host),
        "--strictPort",
      ],
      join(root, "examples/host-app"),
      {
        VITE_SUPPORT_PROJECT_KEY: DEMO_KEY,
        VITE_SUPPORT_USER_EMAIL: DEMO_EMAIL,
        VITE_SUPPORT_API_URL: urls.api,
      },
    ),
  };
  const state: DemoState = {
    ports,
    pids,
    startedStack,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  await ready(`${urls.api}/health`, "API");
  await ready(`${urls.viewer}/health`, "Linear stub");
  await ready(urls.admin, "admin app");
  await ready(`http://127.0.0.1:${ports.host}/`, "host app");
  printSummary(ports);
}

function printSummary(ports: DemoPorts): void {
  const urls = demoUrls(ports, resolveStackEnv(process.env).oidcPort);
  console.log("\n[demo] running");
  console.log(`  API          ${urls.api}/health`);
  console.log(`  Host app     ${urls.host}`);
  console.log(`  Linear stub  ${urls.viewer}   (ticket viewer)`);
  console.log(`  Admin app    ${urls.admin}`);
  console.log(`  Mock issuer  ${urls.issuer}`);
  console.log(
    `  Admin login  any user name at the issuer form; claims {"email":"ada@pressw.test"} are optional`,
  );
  console.log(`  Project key  ${DEMO_KEY}   customer ${DEMO_EMAIL}`);
  console.log(`  Logs         ${logDir}`);
  const notes = degradedNotes(process.env);
  if (notes.length > 0) {
    console.log("\n[demo] degraded steps");
    for (const note of notes) console.log(`  - ${note}`);
  }
  console.log("\n[demo] walkthrough");
  walkthrough(urls).forEach((line, index) => {
    console.log(`  ${index + 1}. ${line}`);
  });
}

async function stop(): Promise<void> {
  const state = readState();
  if (!state) {
    console.log("[demo] nothing to stop");
    return;
  }
  for (const [name, pid] of Object.entries(state.pids)) {
    try {
      process.kill(-pid, "SIGTERM");
      console.log(`[demo] stopped ${name}`);
    } catch {
      console.log(`[demo] ${name} was not running`);
    }
  }
  await Bun.sleep(1_500);
  for (const pid of Object.values(state.pids)) {
    if (isAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  }
  if (state.startedStack) {
    await step("stop the local stack the demo started", [
      "bun",
      "scripts/stack.ts",
      "down",
    ]);
  }
  rmSync(stateFile, { force: true });
  console.log("[demo] stopped");
}

async function comment(args: string[]): Promise<void> {
  const state = readState();
  if (!state) {
    console.error("[demo] the demo is not running; start it with bun run demo");
    process.exit(1);
  }
  const request = commentRequest(args);
  const response = await fetch(
    `http://127.0.0.1:${state.ports.viewer}/api/comment`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  const body = await response.text();
  console.log(
    response.ok
      ? `[demo] posted to ${request.identifier}`
      : `[demo] FAIL ${body}`,
  );
  process.exit(response.ok ? 0 : 1);
}

const [command, ...rest] = process.argv.slice(2);
if (command === undefined || command === "start") await start();
else if (command === "stop") await stop();
else if (command === "comment") await comment(rest);
else if (command === "status") {
  const state = readState();
  if (!state) console.log("[demo] not running");
  else printSummary(state.ports);
} else {
  console.error(
    "usage: bun run demo [start|stop|status|comment <ticket> <text>]",
  );
  process.exit(2);
}
process.exit(0);
