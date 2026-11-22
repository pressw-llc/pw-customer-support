import { describe, expect, test } from "bun:test";
import type { StageConfig } from "@pw-support/infra";
import { parseDeployArgs } from "./lib";
import { type DeployDeps, preflight, runDeploy } from "./run";

const ACCOUNT = "123456789012";
const config = {
  account: ACCOUNT,
  stage: "production",
  placeholders: [],
} as unknown as StageConfig;

const FULL_ENV = {
  AWS_PROFILE: "deploy",
  GITHUB_TOKEN: "t",
  SMOKE_PROJECT_KEY: "k",
  SMOKE_LINEAR_API_KEY: "l",
  SMOKE_LINEAR_TEAM_ID: "team",
};

function harness(
  argv: string[],
  overrides: Partial<DeployDeps> & {
    env?: Record<string, string | undefined>;
  } = {},
) {
  const calls: string[] = [];
  const scopes: string[] = [];
  const identityCalls: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: DeployDeps = {
    args: parseDeployArgs(argv),
    env: FULL_ENV,
    root: "/repo",
    infraDir: "/repo/modules/infra",
    stageFile: "/nope/stage.production.json",
    loadConfig: (_placeholders, scope) => {
      scopes.push(scope);
      return config;
    },
    stageConflicts: async () => [],
    isConfigError: (error): error is { problems: string[] } =>
      typeof error === "object" && error !== null && "problems" in error,
    run: async ({ title }) => {
      calls.push(title);
      return 0;
    },
    identity: async () => {
      identityCalls.push("sts");
      return {
        account: ACCOUNT,
        arn: `arn:aws:sts::${ACCOUNT}:assumed-role/pw-support-production-github-deploy/session`,
      };
    },
    bootstrapVersion: async () => 29,
    dockerAvailable: async () => true,
    writeBuildToken: () => "/repo/.deploy/github_token",
    removeBuildToken: (path) => {
      calls.push(`remove ${path}`);
    },
    stackOutputs: async (name) => {
      calls.push(`outputs ${name}`);
      return { ApiUrl: "https://api.example.test" };
    },
    migrate: async () => {
      calls.push("migrate");
      return { taskArn: "arn:task" };
    },
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    ...overrides,
  };
  return { deps, calls, identityCalls, logs, errors, scopes };
}

const MUTATING =
  /deploy foundation|deploy app|deploy GitHub|migrate|smoke|build image/;

describe("preflight", () => {
  test("a missing smoke variable fails the whole run with one list and no deploy call", async () => {
    const { deps, calls, errors } = harness(["--stage", "production"], {
      env: {
        ...FULL_ENV,
        SMOKE_PROJECT_KEY: undefined,
        SMOKE_LINEAR_TEAM_ID: undefined,
      },
    });
    expect(await runDeploy(deps)).toBe(2);
    expect(calls).toEqual([]);
    const text = errors.join("\n");
    expect(text).toContain("SMOKE_PROJECT_KEY is required");
    expect(text).toContain("SMOKE_LINEAR_TEAM_ID is required");
    expect(text).toContain("nothing was deployed");
  });

  test("--skip-smoke drops only the smoke requirements", async () => {
    const env = {
      ...FULL_ENV,
      SMOKE_PROJECT_KEY: undefined,
      SMOKE_LINEAR_API_KEY: undefined,
      SMOKE_LINEAR_TEAM_ID: undefined,
    };
    const skipped = await preflight(harness(["--skip-smoke"], { env }).deps);
    expect(skipped.ok).toBe(true);
    const withoutToken = await preflight(
      harness(["--skip-smoke"], { env: { ...env, GITHUB_TOKEN: undefined } })
        .deps,
    );
    expect(withoutToken.ok).toBe(false);
    expect(withoutToken.problems.join(" ")).toContain("GITHUB_TOKEN");
  });

  test("lists every problem at once: config, token, Docker, identity, smoke", async () => {
    const { deps } = harness([], {
      env: { AWS_PROFILE: "deploy" },
      loadConfig: () => {
        throw { problems: ["mcpRequiredGroup is required"] };
      },
      dockerAvailable: async () => false,
      identity: async () => ({}),
    });
    const result = await preflight(deps);
    expect(result.ok).toBe(false);
    const text = result.problems.join("\n");
    for (const part of [
      "config: mcpRequiredGroup is required",
      "GITHUB_TOKEN",
      "Docker is not available",
      "AWS identity could not be read",
      "SMOKE_PROJECT_KEY",
      "SMOKE_LINEAR_API_KEY",
      "SMOKE_LINEAR_TEAM_ID",
    ]) {
      expect(text, part).toContain(part);
    }
  });

  test("an identity in another account fails before any deploy call", async () => {
    const { deps, calls, errors } = harness([], {
      identity: async () => ({ account: "999999999999" }),
    });
    expect(await runDeploy(deps)).toBe(2);
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("account 999999999999");
  });

  test("a stage without its own bootstrap qualifier is refused before any deploy call", async () => {
    const asked: string[] = [];
    const { deps, calls, errors } = harness([], {
      bootstrapVersion: async (qualifier) => {
        asked.push(qualifier);
        return undefined;
      },
    });
    expect(await runDeploy(deps)).toBe(2);
    expect(calls).toEqual([]);
    expect(asked).toEqual(["pwsproduct"]);
    expect(errors.join("\n")).toContain("qualifier pwsproduct");
  });

  test("another stage's stack in the account refuses --oidc, --bootstrap, and a deploy before any call", async () => {
    for (const argv of [[], ["--oidc"], ["--bootstrap"]]) {
      const { deps, calls, errors } = harness(argv, {
        env: { ...FULL_ENV },
        stageConflicts: async () => [
          "account: stack PwSupportStaging already belongs to stage staging; V1 supports one stage per AWS account, so production needs its own account",
        ],
      });
      expect(await runDeploy(deps)).toBe(2);
      expect(calls, argv.join(" ")).toEqual([]);
      expect(errors.join("\n")).toContain("one stage per AWS account");
    }
  });

  test("a listing failure cannot be skipped: the rule could not be checked", async () => {
    const { deps, calls, errors } = harness([], {
      stageConflicts: async () => {
        throw new Error("cloudformation down");
      },
    });
    expect(await runDeploy(deps)).toBe(2);
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("could not be listed");
  });

  test("a dry run does not list the account's stacks", async () => {
    const { deps } = harness(["--dry-run"], {
      env: { GITHUB_TOKEN: "t" },
      stageConflicts: async () => {
        throw new Error("must not be called");
      },
    });
    expect(await runDeploy(deps)).toBe(0);
  });

  test("--oidc and --bootstrap refuse a dry run because they change the account", async () => {
    for (const flag of ["--oidc", "--bootstrap"]) {
      const { deps, calls, errors } = harness([flag, "--dry-run"], {
        env: { AWS_PROFILE: "deploy" },
      });
      expect(await runDeploy(deps)).toBe(2);
      expect(calls).toEqual([]);
      expect(errors.join("\n")).toContain("needs AWS credentials");
    }
    const noCredentials = harness(["--oidc"], { env: {} });
    expect(await runDeploy(noCredentials.deps)).toBe(2);
    expect(noCredentials.calls).toEqual([]);
  });

  test("each mode loads the config with its own scope", async () => {
    const seen: Record<string, string[]> = {};
    for (const [name, argv] of [
      ["oidc", ["--oidc"]],
      ["bootstrap", ["--bootstrap"]],
      ["deploy", []],
    ] as const) {
      const h = harness([...argv], { env: { ...FULL_ENV } });
      await preflight(h.deps);
      seen[name] = h.scopes;
    }
    expect(seen).toEqual({
      oidc: ["oidc"],
      bootstrap: ["bootstrap"],
      deploy: ["deploy"],
    });
  });

  test("a stage is refused through another stage's deploy role", async () => {
    const { deps, calls, errors } = harness([], {
      identity: async () => ({
        account: ACCOUNT,
        arn: `arn:aws:sts::${ACCOUNT}:assumed-role/pw-support-staging-github-deploy/s`,
      }),
    });
    expect(await runDeploy(deps)).toBe(2);
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain(
      "refusing to deploy production through pw-support-staging-github-deploy",
    );
  });

  test("--oidc does not need the stage bootstrap, and --bootstrap passes the stage qualifier and execution policies", async () => {
    const oidc = harness(["--oidc"], {
      env: { AWS_PROFILE: "deploy" },
      bootstrapVersion: async () => undefined,
    });
    expect(await runDeploy(oidc.deps)).toBe(0);
    const commands: string[][] = [];
    const bootstrap = harness(["--bootstrap"], {
      env: { AWS_PROFILE: "deploy" },
      bootstrapVersion: async () => undefined,
      stackOutputs: async () => ({
        CloudFormationExecutionPolicies: "arn:policy/one,arn:policy/two",
      }),
      run: async ({ title, command }) => {
        bootstrap.calls.push(title);
        commands.push(command);
        return 0;
      },
    });
    expect(await runDeploy(bootstrap.deps)).toBe(0);
    expect(bootstrap.calls).toEqual(["bootstrap the stage"]);
    const flags = (commands[0] ?? []).join(" ");
    expect(flags).toContain("--qualifier pwsproduct");
    expect(flags).toContain("--toolkit-stack-name CDKToolkit-pwsproduct");
    expect(flags).toContain(
      "--cloudformation-execution-policies arn:policy/one,arn:policy/two",
    );
    expect(flags).toContain("--tags pw-support:stage=production");
    const missing = harness(["--bootstrap"], {
      env: { AWS_PROFILE: "deploy" },
      stackOutputs: async () => ({}),
    });
    expect(await runDeploy(missing.deps)).toBe(1);
    expect(missing.errors.join("\n")).toContain("run --oidc first");
  });

  test("deploy and diff carry the stage toolkit stack name", async () => {
    const commands: string[][] = [];
    const { deps } = harness([], {
      run: async ({ command }) => {
        commands.push(command);
        return 0;
      },
    });
    await runDeploy(deps);
    const deploys = commands.filter(
      (c) => c[2] === "deploy" || c[2] === "diff",
    );
    expect(deploys.length).toBe(3);
    for (const command of deploys) {
      expect(command.join(" ")).toContain(
        "--toolkit-stack-name CDKToolkit-pwsproduct",
      );
    }
  });

  test("a dry run reads no identity and needs no smoke variables", async () => {
    const { deps, calls, identityCalls } = harness(["--dry-run"], {
      env: { GITHUB_TOKEN: "t" },
    });
    expect(await runDeploy(deps)).toBe(0);
    expect(identityCalls).toEqual([]);
    expect(calls).toEqual([
      "build admin and widget",
      "build image target api",
      "build image target lambda",
      "synth stacks",
      "remove /repo/.deploy/github_token",
    ]);
  });

  test("--oidc needs credentials and the account but no smoke variables", async () => {
    const { deps, calls } = harness(["--oidc"], {
      env: { AWS_PROFILE: "deploy" },
    });
    expect(await runDeploy(deps)).toBe(0);
    expect(calls).toEqual(["deploy GitHub OIDC stack"]);
  });
});

describe("runDeploy order", () => {
  test("a complete run builds, deploys the foundation, migrates, deploys the app, then smokes", async () => {
    const { deps, calls, identityCalls } = harness([]);
    expect(await runDeploy(deps)).toBe(0);
    expect(identityCalls).toEqual(["sts"]);
    expect(calls).toEqual([
      "build admin and widget",
      "build image target api",
      "build image target lambda",
      "synth stacks",
      "diff stacks",
      "deploy foundation stack",
      "outputs PwSupport",
      "migrate",
      "deploy app stack",
      "outputs PwSupportApp",
      "smoke test",
      "remove /repo/.deploy/github_token",
    ]);
  });

  test("a failing foundation deploy stops before migration and the app", async () => {
    const { deps, calls } = harness([], {
      run: async ({ title }) => {
        calls.push(title);
        return title === "deploy foundation stack" ? 1 : 0;
      },
    });
    expect(await runDeploy(deps)).toBe(1);
    expect(calls).not.toContain("migrate");
    expect(calls).not.toContain("deploy app stack");
  });

  test("a failing migration stops before the app stack", async () => {
    const { deps, calls, errors } = harness([], {
      migrate: async () => {
        throw new Error("migration task failed: exit 1");
      },
    });
    expect(await runDeploy(deps)).toBe(1);
    expect(calls).not.toContain("deploy app stack");
    expect(errors.join("\n")).toContain("migration task failed");
  });

  test("a failing smoke test fails the run, and --skip-migrate skips only migration", async () => {
    const failing = harness([], {
      run: async ({ title }) => {
        failing.calls.push(title);
        return title === "smoke test" ? 1 : 0;
      },
    });
    expect(await runDeploy(failing.deps)).toBe(1);
    const skipped = harness(["--skip-migrate", "--skip-smoke"]);
    expect(await runDeploy(skipped.deps)).toBe(0);
    expect(skipped.calls).not.toContain("migrate");
    expect(skipped.calls).not.toContain("smoke test");
    expect(skipped.calls).toContain("deploy app stack");
  });

  test("the build token file is removed after a failure too", async () => {
    const { deps, calls } = harness([], {
      run: async ({ title }) => {
        calls.push(title);
        return title === "deploy foundation stack" ? 1 : 0;
      },
    });
    expect(await runDeploy(deps)).toBe(1);
    expect(calls.at(-1)).toBe("remove /repo/.deploy/github_token");
  });

  test("a failing smoke test says the app is already deployed and how to roll back", async () => {
    const { deps, errors } = harness([], {
      run: async ({ title }) => (title === "smoke test" ? 1 : 0),
    });
    expect(await runDeploy(deps)).toBe(1);
    const text = errors.join("\n");
    expect(text).toContain("app stack is deployed and serving");
    expect(text).toContain("--skip-migrate");
  });

  test("a failing OIDC, bootstrap, or app stack step fails the run", async () => {
    const failing = (title: string, argv: string[], extra = {}) => {
      const h = harness(argv, {
        env: { ...FULL_ENV },
        run: async (call) => {
          h.calls.push(call.title);
          return call.title === title ? 1 : 0;
        },
        stackOutputs: async () => ({
          CloudFormationExecutionPolicies: "arn:policy/one",
          ApiUrl: "https://api.example.test",
        }),
        ...extra,
      });
      return h;
    };
    expect(
      await runDeploy(failing("deploy GitHub OIDC stack", ["--oidc"]).deps),
    ).toBe(1);
    expect(
      await runDeploy(failing("bootstrap the stage", ["--bootstrap"]).deps),
    ).toBe(1);
    const app = failing("deploy app stack", []);
    expect(await runDeploy(app.deps)).toBe(1);
    expect(app.calls).not.toContain("smoke test");
  });

  test("a rejecting identity, bootstrap lookup, or stack read is reported, not thrown", async () => {
    const identity = harness([], {
      identity: async () => {
        throw new Error("sts down");
      },
    });
    expect(await runDeploy(identity.deps)).toBe(2);
    expect(identity.errors.join("\n")).toContain("identity could not be read");
    const lookup = harness([], {
      bootstrapVersion: async () => {
        throw new Error("ssm down");
      },
    });
    expect(await runDeploy(lookup.deps)).toBe(2);
    expect(lookup.errors.join("\n")).toContain("needs the CDK bootstrap");
    const outputs = harness(["--bootstrap"], {
      env: { AWS_PROFILE: "deploy" },
      stackOutputs: async () => {
        throw new Error("cloudformation down");
      },
    });
    expect(await runDeploy(outputs.deps)).toBe(1);
    expect(outputs.errors.join("\n")).toContain("run --oidc first");
  });

  test("an OIDC run with an incomplete stage config is a preflight problem", async () => {
    const { deps, calls, errors } = harness(["--oidc"], {
      env: { AWS_PROFILE: "deploy" },
      loadConfig: () => {
        throw { problems: ["adminRequiredGroup is required"] };
      },
    });
    expect(await runDeploy(deps)).toBe(2);
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain(
      "config: adminRequiredGroup is required",
    );
  });

  test("a failing build stops the run before synth", async () => {
    const { deps, calls } = harness([], {
      run: async ({ title }) => {
        calls.push(title);
        return title === "build admin and widget" ? 1 : 0;
      },
    });
    expect(await runDeploy(deps)).toBe(1);
    expect(calls).toEqual(["build admin and widget"]);
  });

  test("the mutating steps never appear in a failed preflight", async () => {
    const { deps, calls } = harness([], { env: { AWS_PROFILE: "deploy" } });
    await runDeploy(deps);
    expect(calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });
});
