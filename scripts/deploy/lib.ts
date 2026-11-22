import { existsSync } from "node:fs";
import {
  type CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  DescribeTasksCommand,
  type ECSClient,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";

export type StageName = "production" | "staging";

export interface DeployArgs {
  stage: StageName;
  dryRun: boolean | undefined;
  oidc: boolean;
  skipAssets: boolean;
  skipSmoke: boolean;
  skipMigrate: boolean;
}

export function parseDeployArgs(argv: string[]): DeployArgs {
  const at = argv.indexOf("--stage");
  const stage = at >= 0 ? argv[at + 1] : "production";
  if (stage !== "production" && stage !== "staging") {
    throw new Error(`--stage takes production or staging, not "${stage}"`);
  }
  return {
    stage,
    dryRun: argv.includes("--dry-run") ? true : undefined,
    oidc: argv.includes("--oidc"),
    skipAssets: argv.includes("--skip-assets"),
    skipSmoke: argv.includes("--skip-smoke"),
    skipMigrate: argv.includes("--skip-migrate"),
  };
}

type EnvLike = Record<string, string | undefined>;

export function hasAwsCredentials(env: EnvLike): boolean {
  return [
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  ].some((key) => Boolean(env[key]));
}

export function chooseMode(
  args: Pick<DeployArgs, "dryRun">,
  env: EnvLike,
): "dry-run" | "deploy" {
  if (args.dryRun) return "dry-run";
  return hasAwsCredentials(env) ? "deploy" : "dry-run";
}

export function usesRealConfig(
  stageFile: string,
  env: EnvLike,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return exists(stageFile) || Boolean(env.SUPPORT_STAGE_CONFIG);
}

export function allowPlaceholders(
  mode: "dry-run" | "deploy",
  realConfig: boolean,
): boolean {
  return mode === "dry-run" && !realConfig;
}

export function stepsFor(
  mode: "dry-run" | "deploy",
  args: DeployArgs,
): string[] {
  const common = ["validate config", "build admin and widget"];
  if (args.oidc) return [...common, "deploy GitHub OIDC stack"];
  const assets = args.skipAssets ? [] : ["build images"];
  if (mode === "dry-run") {
    return [...common, ...assets, "synth stacks"];
  }
  return [
    ...common,
    "check AWS account",
    ...assets,
    "synth stacks",
    "diff stacks",
    "deploy foundation stack",
    ...(args.skipMigrate ? [] : ["run migration task"]),
    "deploy app stack",
    ...(args.skipSmoke ? [] : ["smoke test"]),
  ];
}

export function stackNames(stage: StageName) {
  const suffix = stage === "production" ? "" : "Staging";
  return {
    foundation: `PwSupport${suffix}`,
    app: `PwSupport${suffix}App`,
    oidc: `PwSupport${suffix}GithubOidc`,
  };
}

export async function readStackOutputs(
  client: Pick<CloudFormationClient, "send">,
  stackName: string,
): Promise<Record<string, string>> {
  const result = await client.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const outputs = result.Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(
    outputs
      .filter((output) => output.OutputKey && output.OutputValue !== undefined)
      .map((output) => [
        output.OutputKey as string,
        output.OutputValue as string,
      ]),
  );
}

export function findOutput(
  outputs: Record<string, string>,
  fragment: string,
): string {
  const key = Object.keys(outputs).find((name) => name.includes(fragment));
  if (!key) throw new Error(`stack output containing "${fragment}" not found`);
  return outputs[key] as string;
}

export interface MigrationOptions {
  ecs: Pick<ECSClient, "send">;
  outputs: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export async function runMigrationTask(
  options: MigrationOptions,
): Promise<{ taskArn: string }> {
  const { ecs, outputs } = options;
  const cluster = findOutput(outputs, "ClusterName");
  const started = await ecs.send(
    new RunTaskCommand({
      cluster,
      taskDefinition: findOutput(outputs, "MigrationTaskDefinitionArn"),
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: findOutput(outputs, "ServiceSubnets").split(","),
          securityGroups: [findOutput(outputs, "ServiceSecurityGroupId")],
          assignPublicIp: "DISABLED",
        },
      },
    }),
  );
  const taskArn = started.tasks?.[0]?.taskArn;
  if (!taskArn) {
    throw new Error(
      `migration task did not start: ${JSON.stringify(started.failures ?? [])}`,
    );
  }

  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 10 * 60_000);
  while (now() < deadline) {
    const described = await ecs.send(
      new DescribeTasksCommand({ cluster, tasks: [taskArn] }),
    );
    const task = described.tasks?.[0];
    if (task?.lastStatus === "STOPPED") {
      const container = task.containers?.[0];
      if (container?.exitCode === 0) return { taskArn };
      throw new Error(
        `migration task failed: exit ${container?.exitCode ?? "none"}, ${task.stoppedReason ?? container?.reason ?? "no reason"}`,
      );
    }
    await sleep(options.pollMs ?? 5_000);
  }
  throw new Error("migration task did not stop before the timeout");
}

export function missingBuildToken(env: EnvLike): boolean {
  return !(env.GITHUB_TOKEN || env.GH_PACKAGES_TOKEN);
}

export function smokeEnvProblems(env: EnvLike): string[] {
  return [
    ["SMOKE_PROJECT_KEY", "a project key minted for the smoke project"],
    ["SMOKE_LINEAR_API_KEY", "a Linear key that can read the smoke team"],
  ]
    .filter(([name]) => !env[name as string])
    .map(([name, hint]) => `${name} is required: ${hint}`);
}
