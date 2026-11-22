import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { ECSClient } from "@aws-sdk/client-ecs";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  ConfigError,
  INFRA_DIR,
  loadStageConfig,
  stageFile,
} from "@pw-support/infra";
import {
  allowPlaceholders,
  chooseMode,
  findOutput,
  missingBuildToken,
  parseDeployArgs,
  readStackOutputs,
  runMigrationTask,
  smokeEnvProblems,
  stackNames,
  stepsFor,
  usesRealConfig,
} from "./lib";

const root = join(import.meta.dir, "..", "..");
const REGION = "us-east-1";

let args: ReturnType<typeof parseDeployArgs>;
try {
  args = parseDeployArgs(process.argv.slice(2));
} catch (error) {
  console.error(`[deploy] ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}

const mode = chooseMode(args, process.env);
const stacks = stackNames(args.stage);
const plan = stepsFor(mode, args);
console.log(`[deploy] stage ${args.stage}, mode ${mode}`);
console.log(`[deploy] steps: ${plan.join(" > ")}`);

function fail(message: string, code = 1): never {
  console.error(`[deploy] FAIL ${message}`);
  process.exit(code);
}

async function run(
  title: string,
  command: string[],
  cwd = root,
): Promise<void> {
  console.log(`\n[deploy] ${title}`);
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env as Record<string, string>,
  });
  if ((await proc.exited) !== 0) fail(`${title} failed`);
}

const realConfig = usesRealConfig(stageFile(args.stage), process.env);
const placeholders = allowPlaceholders(mode, realConfig);
let config: ReturnType<typeof loadStageConfig>;
try {
  config = loadStageConfig({ stage: args.stage, placeholders });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`[deploy] ${error.message}`);
    console.error(
      `[deploy] set the values in ${stageFile(args.stage)} (see stage.example.json) or in SUPPORT_STAGE_CONFIG`,
    );
    process.exit(2);
  }
  throw error;
}
console.log(
  placeholders
    ? `[deploy] PASS config uses placeholders for ${config.placeholders.join(", ")}; nothing here is deployable`
    : `[deploy] PASS config for account ${config.account}`,
);

const cdk = (...extra: string[]) => [
  "bunx",
  "cdk",
  ...extra,
  "-c",
  `stage=${args.stage}`,
  "-c",
  `placeholders=${placeholders}`,
  "--no-notices",
];

await run("build admin and widget", ["bun", "run", "build"]);

if (args.oidc) {
  if (mode !== "deploy") fail("--oidc needs AWS credentials", 2);
  await run(
    "deploy GitHub OIDC stack",
    cdk("deploy", stacks.oidc, "--require-approval", "never"),
    INFRA_DIR,
  );
  process.exit(0);
}

const tokenPath = join(root, ".deploy", "github_token");
if (!args.skipAssets || mode === "deploy") {
  if (missingBuildToken(process.env)) {
    fail(
      "GITHUB_TOKEN (read:packages) is required to build the image; export it first",
      2,
    );
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(
    tokenPath,
    (process.env.GITHUB_TOKEN || process.env.GH_PACKAGES_TOKEN) as string,
    { mode: 0o600 },
  );
  chmodSync(tokenPath, 0o600);
}

if (mode === "deploy") {
  const identity = await new STSClient({ region: REGION }).send(
    new GetCallerIdentityCommand({}),
  );
  if (identity.Account !== config.account) {
    fail(
      `credentials belong to account ${identity.Account}, the stage config names ${config.account}`,
      2,
    );
  }
  console.log(`[deploy] PASS credentials match account ${config.account}`);
}

if (!args.skipAssets) {
  for (const target of ["api", "lambda"]) {
    await run(`build image target ${target}`, [
      "docker",
      "build",
      "--secret",
      `id=github_token,src=${tokenPath}`,
      "--target",
      target,
      "-t",
      `pw-support-${target}:deploy`,
      ".",
    ]);
  }
}

await run("synth stacks", cdk("synth", "--quiet"), INFRA_DIR);

if (mode === "dry-run") {
  console.log(
    "\n[deploy] DRY RUN complete: config, build, images, and synth passed; no AWS call was made",
  );
  process.exit(0);
}

await run(
  "diff stacks",
  cdk("diff", stacks.foundation, stacks.app),
  INFRA_DIR,
).catch(() => undefined);

await run(
  "deploy foundation stack",
  cdk("deploy", stacks.foundation, "--require-approval", "never"),
  INFRA_DIR,
);

if (!args.skipMigrate) {
  console.log("\n[deploy] run migration task");
  const cfn = new CloudFormationClient({ region: REGION });
  const outputs = await readStackOutputs(cfn, stacks.foundation);
  const { taskArn } = await runMigrationTask({
    ecs: new ECSClient({ region: REGION }),
    outputs,
  }).catch((error) => fail(String(error.message ?? error)));
  console.log(`[deploy] PASS migration task ${taskArn} exited 0`);
}

await run(
  "deploy app stack",
  cdk("deploy", stacks.app, "--require-approval", "never"),
  INFRA_DIR,
);

if (!args.skipSmoke) {
  const problems = smokeEnvProblems(process.env);
  if (problems.length > 0) fail(problems.join("; "), 2);
  const outputs = await readStackOutputs(
    new CloudFormationClient({ region: REGION }),
    stacks.app,
  );
  const apiUrl = findOutput(outputs, "ApiUrl");
  await run("smoke test", ["bun", "scripts/smoke.ts", "--api-url", apiUrl]);
}

console.log(`\n[deploy] PASS ${args.stage} deployed`);
