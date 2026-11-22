import { resourceNames } from "@pw-support/contracts";
import type { StageConfig } from "@pw-support/infra";
import {
  allowPlaceholders,
  chooseMode,
  type DeployArgs,
  findOutput,
  missingBuildToken,
  smokeEnvProblems,
  stackNames,
  stepsFor,
  usesRealConfig,
} from "./lib";

type EnvLike = Record<string, string | undefined>;

export interface RunnerCall {
  title: string;
  command: string[];
  cwd: string;
}

export interface DeployDeps {
  args: DeployArgs;
  env: EnvLike;
  root: string;
  infraDir: string;
  stageFile: string;
  loadConfig(placeholders: boolean): StageConfig;
  isConfigError(error: unknown): error is { problems: string[] };
  run(call: RunnerCall): Promise<number>;
  identity(): Promise<{ account?: string; arn?: string }>;
  bootstrapVersion(qualifier: string): Promise<number | undefined>;
  dockerAvailable(): Promise<boolean>;
  writeBuildToken(token: string): string;
  removeBuildToken(path: string): void;
  stackOutputs(stackName: string): Promise<Record<string, string>>;
  migrate(outputs: Record<string, string>): Promise<{ taskArn: string }>;
  log(line: string): void;
  error(line: string): void;
}

export interface Preflight {
  ok: boolean;
  problems: string[];
  mode: "dry-run" | "deploy";
  placeholders: boolean;
  config?: StageConfig;
  steps: string[];
}

export async function preflight(deps: DeployDeps): Promise<Preflight> {
  const { args, env } = deps;
  const mode = chooseMode(args, env);
  const placeholders = allowPlaceholders(
    mode,
    usesRealConfig(deps.stageFile, env),
  );
  const problems: string[] = [];
  const steps = stepsFor(mode, args);

  let config: StageConfig | undefined;
  try {
    config = deps.loadConfig(placeholders);
  } catch (error) {
    if (!deps.isConfigError(error)) throw error;
    problems.push(...error.problems.map((line) => `config: ${line}`));
  }

  const needsImages =
    !args.oidc && !args.bootstrap && (!args.skipAssets || mode === "deploy");
  if (needsImages) {
    if (missingBuildToken(env)) {
      problems.push(
        "build: GITHUB_TOKEN (read:packages) is required to build the image",
      );
    }
    if (!(await deps.dockerAvailable())) {
      problems.push("build: Docker is not available for the image build");
    }
  }

  if (mode === "deploy") {
    if (args.oidc && !config) {
      problems.push("oidc: the stage config must be complete");
    }
    const who = await deps
      .identity()
      .catch(() => ({}) as { account?: string; arn?: string });
    if (!who.account) {
      problems.push("credentials: the AWS identity could not be read");
    } else if (config && who.account !== config.account) {
      problems.push(
        `credentials: the identity belongs to account ${who.account}, the stage config names ${config.account}`,
      );
    }
    const names = resourceNames(args.stage);
    const role = who.arn?.match(
      /assumed-role\/(pw-support-[a-z0-9-]*-github-deploy)\//,
    )?.[1];
    if (role && role !== names.githubDeployRole) {
      problems.push(
        `credentials: refusing to deploy ${args.stage} through ${role}; use ${names.githubDeployRole}`,
      );
    }
    if (who.account && !args.oidc && !args.bootstrap) {
      const version = await deps
        .bootstrapVersion(names.bootstrapQualifier)
        .catch(() => undefined);
      if (version === undefined) {
        problems.push(
          `bootstrap: stage ${args.stage} needs the CDK bootstrap with qualifier ${names.bootstrapQualifier}; run bun run deploy --stage ${args.stage} --oidc and then --bootstrap with admin credentials`,
        );
      }
    }
    if (!args.oidc && !args.bootstrap && !args.skipSmoke) {
      problems.push(...smokeEnvProblems(env).map((line) => `smoke: ${line}`));
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    mode,
    placeholders,
    config,
    steps,
  };
}

export async function runDeploy(deps: DeployDeps): Promise<number> {
  const cleanup: string[] = [];
  try {
    return await execute(deps, cleanup);
  } finally {
    for (const path of cleanup) deps.removeBuildToken(path);
  }
}

async function execute(deps: DeployDeps, cleanup: string[]): Promise<number> {
  const { args, root, infraDir } = deps;
  const plan = await preflight(deps);
  deps.log(`[deploy] stage ${args.stage}, mode ${plan.mode}`);
  deps.log(`[deploy] steps: ${plan.steps.join(" > ")}`);
  if (!plan.ok) {
    deps.error(
      "[deploy] FAIL preflight found missing items, nothing was deployed:",
    );
    for (const problem of plan.problems) deps.error(`  - ${problem}`);
    return 2;
  }
  const config = plan.config as StageConfig;
  deps.log(
    plan.placeholders
      ? `[deploy] PASS config uses placeholders for ${config.placeholders.join(", ")}; nothing here is deployable`
      : `[deploy] PASS preflight for account ${config.account}`,
  );

  const stacks = stackNames(args.stage);
  const step = async (
    title: string,
    command: string[],
    cwd = root,
  ): Promise<boolean> => {
    deps.log(`\n[deploy] ${title}`);
    if ((await deps.run({ title, command, cwd })) !== 0) {
      deps.error(`[deploy] FAIL ${title} failed`);
      return false;
    }
    return true;
  };
  const qualifier = resourceNames(args.stage).bootstrapQualifier;
  const cdk = (...extra: string[]) => [
    "bunx",
    "cdk",
    ...extra,
    ...(extra[0] === "deploy" || extra[0] === "diff"
      ? ["--toolkit-stack-name", `CDKToolkit-${qualifier}`]
      : []),
    "-c",
    `stage=${args.stage}`,
    "-c",
    `placeholders=${plan.placeholders}`,
    "--no-notices",
  ];

  if (args.bootstrap) {
    const outputs = await deps.stackOutputs(stacks.oidc).catch(() => ({}));
    const policies = Object.entries(outputs).find(([key]) =>
      key.includes("CloudFormationExecutionPolicies"),
    )?.[1];
    if (!policies) {
      deps.error(
        `[deploy] FAIL the ${stacks.oidc} stack has no execution policies; run --oidc first`,
      );
      return 1;
    }
    return (await step(
      "bootstrap the stage",
      [
        "bunx",
        "cdk",
        "bootstrap",
        `aws://${config.account}/us-east-1`,
        "--qualifier",
        qualifier,
        "--toolkit-stack-name",
        `CDKToolkit-${qualifier}`,
        "--cloudformation-execution-policies",
        policies,
        "--tags",
        `${resourceNames(args.stage).stageTag}=${args.stage}`,
        "--no-notices",
      ],
      infraDir,
    ))
      ? 0
      : 1;
  }

  if (!(await step("build admin and widget", ["bun", "run", "build"])))
    return 1;

  if (args.oidc) {
    return (await step(
      "deploy GitHub OIDC stack",
      cdk("deploy", stacks.oidc, "--require-approval", "never"),
      infraDir,
    ))
      ? 0
      : 1;
  }

  const tokenPath = deps.writeBuildToken(
    (deps.env.GITHUB_TOKEN || deps.env.GH_PACKAGES_TOKEN) as string,
  );
  cleanup.push(tokenPath);
  if (!args.skipAssets) {
    for (const target of ["api", "lambda"]) {
      const built = await step(`build image target ${target}`, [
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
      if (!built) return 1;
    }
  }

  if (!(await step("synth stacks", cdk("synth", "--quiet"), infraDir)))
    return 1;

  if (plan.mode === "dry-run") {
    deps.log(
      "\n[deploy] DRY RUN complete: config, build, images, and synth passed; no AWS call was made",
    );
    return 0;
  }

  await step(
    "diff stacks",
    cdk("diff", stacks.foundation, stacks.app),
    infraDir,
  );

  if (
    !(await step(
      "deploy foundation stack",
      cdk("deploy", stacks.foundation, "--require-approval", "never"),
      infraDir,
    ))
  ) {
    return 1;
  }

  if (!args.skipMigrate) {
    deps.log("\n[deploy] run migration task");
    try {
      const outputs = await deps.stackOutputs(stacks.foundation);
      const { taskArn } = await deps.migrate(outputs);
      deps.log(`[deploy] PASS migration task ${taskArn} exited 0`);
    } catch (error) {
      deps.error(
        `[deploy] FAIL ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  if (
    !(await step(
      "deploy app stack",
      cdk("deploy", stacks.app, "--require-approval", "never"),
      infraDir,
    ))
  ) {
    return 1;
  }

  if (!args.skipSmoke) {
    const apiUrl = findOutput(await deps.stackOutputs(stacks.app), "ApiUrl");
    if (
      !(await step("smoke test", [
        "bun",
        "scripts/smoke.ts",
        "--api-url",
        apiUrl,
      ]))
    ) {
      deps.error(
        `[deploy] the app stack is deployed and serving, but the smoke test failed; check the API logs, then roll back with the previous commit and --skip-migrate if the release is bad`,
      );
      return 1;
    }
  }

  deps.log(`\n[deploy] PASS ${args.stage} deployed`);
  return 0;
}
