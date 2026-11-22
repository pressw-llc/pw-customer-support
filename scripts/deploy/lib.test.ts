import { describe, expect, test } from "bun:test";
import {
  allowPlaceholders,
  chooseMode,
  findOutput,
  findStageConflicts,
  hasAwsCredentials,
  missingBuildToken,
  parseDeployArgs,
  readStackOutputs,
  runMigrationTask,
  smokeEnvProblems,
  stackNames,
  stageOfStack,
  stepsFor,
  usesRealConfig,
} from "./lib";

const outputs = {
  ExportsOutputClusterName: "cluster-1",
  MigrationTaskDefinitionArn: "arn:task-def",
  ServiceSubnets: "subnet-a,subnet-b",
  ServiceSecurityGroupId: "sg-1",
};

function fakeEcs(script: { stopped: unknown; runTasks?: unknown[] }) {
  const sent: unknown[] = [];
  let describes = 0;
  return {
    sent,
    client: {
      send: async (command: {
        constructor: { name: string };
        input: unknown;
      }) => {
        sent.push(command);
        if (command.constructor.name === "RunTaskCommand") {
          return {
            tasks: script.runTasks ?? [{ taskArn: "arn:task/1" }],
            failures: [],
          };
        }
        describes += 1;
        return describes < 2
          ? { tasks: [{ lastStatus: "RUNNING" }] }
          : { tasks: [script.stopped] };
      },
    } as never,
  };
}

describe("parseDeployArgs", () => {
  test("defaults to production with no flags", () => {
    expect(parseDeployArgs([])).toEqual({
      stage: "production",
      dryRun: undefined,
      oidc: false,
      bootstrap: false,
      skipAssets: false,
      skipSmoke: false,
      skipMigrate: false,
    });
  });

  test("reads every flag", () => {
    expect(
      parseDeployArgs([
        "--stage",
        "staging",
        "--dry-run",
        "--oidc",
        "--bootstrap",
        "--skip-assets",
        "--skip-smoke",
        "--skip-migrate",
      ]),
    ).toEqual({
      stage: "staging",
      dryRun: true,
      oidc: true,
      bootstrap: true,
      skipAssets: true,
      skipSmoke: true,
      skipMigrate: true,
    });
  });

  test("rejects an unknown stage", () => {
    expect(() => parseDeployArgs(["--stage", "dev"])).toThrow(
      "production or staging",
    );
  });
});

describe("mode", () => {
  test("detects AWS credentials from the environment", () => {
    expect(hasAwsCredentials({})).toBe(false);
    expect(hasAwsCredentials({ AWS_PROFILE: "x" })).toBe(true);
    expect(hasAwsCredentials({ AWS_ACCESS_KEY_ID: "x" })).toBe(true);
    expect(hasAwsCredentials({ AWS_WEB_IDENTITY_TOKEN_FILE: "/t" })).toBe(true);
  });

  test("defaults to a dry run without credentials and honors --dry-run with them", () => {
    expect(chooseMode({ dryRun: undefined }, {})).toBe("dry-run");
    expect(chooseMode({ dryRun: undefined }, { AWS_PROFILE: "x" })).toBe(
      "deploy",
    );
    expect(chooseMode({ dryRun: true }, { AWS_PROFILE: "x" })).toBe("dry-run");
  });

  test("allows placeholders only for a dry run with no real config", () => {
    expect(usesRealConfig("/x", {}, () => false)).toBe(false);
    expect(usesRealConfig("/x", {}, () => true)).toBe(true);
    expect(
      usesRealConfig("/x", { SUPPORT_STAGE_CONFIG: "{}" }, () => false),
    ).toBe(true);
    expect(allowPlaceholders("dry-run", false)).toBe(true);
    expect(allowPlaceholders("dry-run", true)).toBe(false);
    expect(allowPlaceholders("deploy", false)).toBe(false);
  });
});

describe("stepsFor", () => {
  const args = parseDeployArgs([]);

  test("a dry run builds and synthesizes and sends nothing to AWS", () => {
    const steps = stepsFor("dry-run", args);
    expect(steps).toEqual([
      "validate config",
      "build admin and widget",
      "build images",
      "synth stacks",
    ]);
  });

  test("a deploy migrates between the two stacks and ends with the smoke test", () => {
    const steps = stepsFor("deploy", args);
    expect(steps.indexOf("deploy foundation stack")).toBeLessThan(
      steps.indexOf("run migration task"),
    );
    expect(steps.indexOf("run migration task")).toBeLessThan(
      steps.indexOf("deploy app stack"),
    );
    expect(steps.at(-1)).toBe("smoke test");
  });

  test("skip flags drop their steps and --oidc deploys only the bootstrap stack", () => {
    const skipped = stepsFor(
      "deploy",
      parseDeployArgs(["--skip-assets", "--skip-smoke", "--skip-migrate"]),
    );
    expect(skipped).not.toContain("build images");
    expect(skipped).not.toContain("smoke test");
    expect(skipped).not.toContain("run migration task");
    expect(stepsFor("deploy", parseDeployArgs(["--oidc"]))).toEqual([
      "validate config",
      "build admin and widget",
      "deploy GitHub OIDC stack",
    ]);
  });

  test("names stacks per stage", () => {
    expect(stackNames("production")).toEqual({
      foundation: "PwSupport",
      app: "PwSupportApp",
      oidc: "PwSupportGithubOidc",
    });
    expect(stackNames("staging").foundation).toBe("PwSupportStaging");
  });
});

describe("stack outputs", () => {
  test("reads outputs into a map and finds one by fragment", async () => {
    const map = await readStackOutputs(
      {
        send: async () => ({
          Stacks: [
            {
              Outputs: [
                { OutputKey: "ApiUrl", OutputValue: "https://api" },
                { OutputKey: "Empty" },
              ],
            },
          ],
        }),
      } as never,
      "PwSupportApp",
    );
    expect(map).toEqual({ ApiUrl: "https://api" });
    expect(findOutput(map, "Api")).toBe("https://api");
    expect(() => findOutput(map, "Missing")).toThrow("not found");
    expect(
      Object.keys(
        await readStackOutputs({ send: async () => ({}) } as never, "x"),
      ),
    ).toEqual([]);
  });
});

describe("runMigrationTask", () => {
  const fast = { sleep: async () => {}, pollMs: 1 };

  test("starts one private Fargate task and waits for exit code zero", async () => {
    const ecs = fakeEcs({
      stopped: { lastStatus: "STOPPED", containers: [{ exitCode: 0 }] },
    });
    const result = await runMigrationTask({
      ecs: ecs.client,
      outputs,
      ...fast,
    });
    expect(result.taskArn).toBe("arn:task/1");
    const run = ecs.sent[0] as { input: Record<string, unknown> };
    expect(run.input.cluster).toBe("cluster-1");
    expect(run.input.launchType).toBe("FARGATE");
    expect(JSON.stringify(run.input.networkConfiguration)).toContain(
      "DISABLED",
    );
    expect(JSON.stringify(run.input.networkConfiguration)).toContain(
      "subnet-b",
    );
  });

  test("fails with the exit code and stop reason", async () => {
    const ecs = fakeEcs({
      stopped: {
        lastStatus: "STOPPED",
        stoppedReason: "Essential container exited",
        containers: [{ exitCode: 1 }],
      },
    });
    await expect(
      runMigrationTask({ ecs: ecs.client, outputs, ...fast }),
    ).rejects.toThrow("exit 1, Essential container exited");
  });

  test("fails when the task never starts or never stops", async () => {
    const none = fakeEcs({ stopped: {}, runTasks: [] });
    await expect(
      runMigrationTask({ ecs: none.client, outputs, ...fast }),
    ).rejects.toThrow("did not start");
    let clock = 0;
    const hang = {
      send: async (command: { constructor: { name: string } }) =>
        command.constructor.name === "RunTaskCommand"
          ? { tasks: [{ taskArn: "t" }] }
          : { tasks: [{ lastStatus: "RUNNING" }] },
    } as never;
    await expect(
      runMigrationTask({
        ecs: hang,
        outputs,
        timeoutMs: 10,
        pollMs: 5,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow("before the timeout");
  });
});

describe("environment checks", () => {
  test("flags a missing build token", () => {
    expect(missingBuildToken({})).toBe(true);
    expect(missingBuildToken({ GH_PACKAGES_TOKEN: "t" })).toBe(false);
  });

  test("lists missing smoke settings", () => {
    expect(smokeEnvProblems({})).toHaveLength(3);
    expect(
      smokeEnvProblems({
        SMOKE_PROJECT_KEY: "k",
        SMOKE_LINEAR_API_KEY: "l",
        SMOKE_LINEAR_TEAM_ID: "t",
      }),
    ).toEqual([]);
  });
});

describe("one stage per account in CloudFormation", () => {
  function fakeCfn(stacks: { name: string; stage?: string }[], pages = 1) {
    const sent: string[] = [];
    const per = Math.ceil(stacks.length / pages) || 1;
    return {
      sent,
      client: {
        send: async (command: {
          constructor: { name: string };
          input: { NextToken?: string; StackName?: string };
        }) => {
          sent.push(command.constructor.name);
          if (command.constructor.name === "ListStacksCommand") {
            const start = Number(command.input.NextToken ?? 0);
            const slice = stacks.slice(start, start + per);
            return {
              StackSummaries: slice.map((stack) => ({ StackName: stack.name })),
              NextToken:
                start + per < stacks.length ? String(start + per) : undefined,
            };
          }
          const found = stacks.find((s) => s.name === command.input.StackName);
          return {
            Stacks: [
              {
                Tags: found?.stage
                  ? [{ Key: "pw-support:stage", Value: found.stage }]
                  : [],
              },
            ],
          };
        },
      } as never,
    };
  }

  test("an empty account has no conflict", async () => {
    expect(await findStageConflicts(fakeCfn([]).client, "production")).toEqual(
      [],
    );
  });

  test("a stack of the same stage is not a conflict", async () => {
    const { client } = fakeCfn([
      { name: "PwSupport", stage: "production" },
      { name: "PwSupportApp", stage: "production" },
      { name: "CDKToolkit-pwsproduct" },
    ]);
    expect(await findStageConflicts(client, "production")).toEqual([]);
  });

  test("a stack of another stage refuses the stage, by tag or by name", async () => {
    const tagged = await findStageConflicts(
      fakeCfn([{ name: "PwSupport", stage: "staging" }]).client,
      "production",
    );
    expect(tagged[0]).toContain("already belongs to stage staging");
    expect(tagged[0]).toContain("one stage per AWS account");
    const byName = await findStageConflicts(
      fakeCfn([{ name: "PwSupportStagingApp" }]).client,
      "production",
    );
    expect(byName[0]).toContain("stage staging");
    const reverse = await findStageConflicts(
      fakeCfn([{ name: "PwSupportApp" }]).client,
      "staging",
    );
    expect(reverse[0]).toContain("stage production");
  });

  test("it pages through every stack and only reads", async () => {
    const stacks = Array.from({ length: 5 }, (_, i) => ({
      name: `PwSupportX${i}`,
      stage: i === 4 ? "staging" : "production",
    }));
    const { client, sent } = fakeCfn(stacks, 3);
    const conflicts = await findStageConflicts(client, "production");
    expect(conflicts).toHaveLength(1);
    expect(new Set(sent)).toEqual(
      new Set(["ListStacksCommand", "DescribeStacksCommand"]),
    );
  });

  test("stageOfStack prefers the tag over the name", () => {
    expect(
      stageOfStack("PwSupportStaging", [
        { Key: "pw-support:stage", Value: "production" },
      ]),
    ).toBe("production");
    expect(stageOfStack("PwSupportStaging", undefined)).toBe("staging");
    expect(stageOfStack("PwSupport", undefined)).toBe("production");
  });
});
