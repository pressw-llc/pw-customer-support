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
  const identityCalls: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: DeployDeps = {
    args: parseDeployArgs(argv),
    env: FULL_ENV,
    root: "/repo",
    infraDir: "/repo/modules/infra",
    stageFile: "/nope/stage.production.json",
    loadConfig: () => config,
    isConfigError: (error): error is { problems: string[] } =>
      typeof error === "object" && error !== null && "problems" in error,
    run: async ({ title }) => {
      calls.push(title);
      return 0;
    },
    identityAccount: async () => {
      identityCalls.push("sts");
      return ACCOUNT;
    },
    dockerAvailable: async () => true,
    writeBuildToken: () => "/repo/.deploy/github_token",
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
  return { deps, calls, identityCalls, logs, errors };
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
      identityAccount: async () => undefined,
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
      identityAccount: async () => "999999999999",
    });
    expect(await runDeploy(deps)).toBe(2);
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("account 999999999999");
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
    ]);
  });

  test("--oidc needs credentials and the account but no smoke variables", async () => {
    const { deps, calls } = harness(["--oidc"], {
      env: { AWS_PROFILE: "deploy" },
    });
    expect(await runDeploy(deps)).toBe(0);
    expect(calls).toEqual([
      "build admin and widget",
      "deploy GitHub OIDC stack",
    ]);
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
