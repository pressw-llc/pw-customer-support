import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { ECSClient } from "@aws-sdk/client-ecs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  ConfigError,
  INFRA_DIR,
  loadStageConfig,
  stageFile,
} from "@pw-support/infra";
import { parseDeployArgs, readStackOutputs, runMigrationTask } from "./lib";
import { runDeploy } from "./run";

const root = join(import.meta.dir, "..", "..");
const REGION = "us-east-1";

let args: ReturnType<typeof parseDeployArgs>;
try {
  args = parseDeployArgs(process.argv.slice(2));
} catch (error) {
  console.error(`[deploy] ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}

const cfn = new CloudFormationClient({ region: REGION });
const code = await runDeploy({
  args,
  env: process.env,
  root,
  infraDir: INFRA_DIR,
  stageFile: stageFile(args.stage),
  loadConfig: (placeholders) =>
    loadStageConfig({ stage: args.stage, placeholders }),
  isConfigError: (error): error is ConfigError => error instanceof ConfigError,
  run: async ({ command, cwd }) => {
    const proc = Bun.spawn(command, {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
      env: process.env as Record<string, string>,
    });
    return proc.exited;
  },
  identity: async () => {
    const who = await new STSClient({ region: REGION }).send(
      new GetCallerIdentityCommand({}),
    );
    return { account: who.Account, arn: who.Arn };
  },
  bootstrapVersion: async (qualifier) => {
    try {
      const parameter = await new SSMClient({ region: REGION }).send(
        new GetParameterCommand({
          Name: `/cdk-bootstrap/${qualifier}/version`,
        }),
      );
      const version = Number(parameter.Parameter?.Value);
      return Number.isFinite(version) ? version : undefined;
    } catch {
      return undefined;
    }
  },
  dockerAvailable: async () => {
    const probe = Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await probe.exited) === 0;
  },
  writeBuildToken: (token) => {
    const path = join(root, ".deploy", "github_token");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, token, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  },
  removeBuildToken: (path) => rmSync(path, { force: true }),
  stackOutputs: (name) => readStackOutputs(cfn, name),
  migrate: (outputs) =>
    runMigrationTask({ ecs: new ECSClient({ region: REGION }), outputs }),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});
process.exit(code);
