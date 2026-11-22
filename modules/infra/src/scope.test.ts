import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  accountConflicts,
  ConfigError,
  type ConfigScope,
  type RawValues,
  REQUIRED_KEYS,
  resolveStageConfig,
} from "./config";
import { loadStageConfig, stageFile } from "./load-config";
import { createOidcStack } from "./stacks";

const FULL: RawValues = {
  account: "123456789012",
  cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_X",
  adminClientId: "a",
  mcpClientId: "m",
  mcpRequiredGroup: "staff",
  adminRequiredGroup: "admins",
  certificateArn:
    "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555",
  apiDomain: "api.example.com",
  triageAgentId: "agent_1",
};

function outcome(scope: ConfigScope, values: RawValues): string[] {
  try {
    resolveStageConfig({
      stage: "production",
      scope,
      values,
      placeholders: false,
    });
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

const without = (keys: string[]): RawValues =>
  Object.fromEntries(
    Object.entries(FULL).filter(([key]) => !keys.includes(key)),
  );

describe("required stage keys per mode", () => {
  const table: {
    name: string;
    scope: ConfigScope;
    values: RawValues;
    ok: boolean;
  }[] = [
    {
      name: "oidc with only the account",
      scope: "oidc",
      values: { account: "123456789012" },
      ok: true,
    },
    { name: "oidc without the account", scope: "oidc", values: {}, ok: false },
    {
      name: "oidc with a bad account",
      scope: "oidc",
      values: { account: "12" },
      ok: false,
    },
    {
      name: "oidc with a bad certificate when given",
      scope: "oidc",
      values: { account: "123456789012", certificateArn: "nope" },
      ok: false,
    },
    {
      name: "oidc ignores unrelated invalid values",
      scope: "oidc",
      values: {
        account: "123456789012",
        cognitoIssuer: "http://x",
        mcpRequiredGroup: "",
      },
      ok: true,
    },
    {
      name: "bootstrap with only the account",
      scope: "bootstrap",
      values: { account: "123456789012" },
      ok: true,
    },
    {
      name: "bootstrap without the account",
      scope: "bootstrap",
      values: {},
      ok: false,
    },
    { name: "deploy with every key", scope: "deploy", values: FULL, ok: true },
    {
      name: "deploy with only the account",
      scope: "deploy",
      values: { account: "123456789012" },
      ok: false,
    },
    ...REQUIRED_KEYS.deploy.map((key) => ({
      name: `deploy without ${key}`,
      scope: "deploy" as const,
      values: without([key]),
      ok: false,
    })),
  ];

  for (const row of table) {
    test(row.name, () => {
      const problems = outcome(row.scope, row.values);
      expect(problems.length === 0).toBe(row.ok);
    });
  }

  test("every mode lists the keys it requires", () => {
    expect(REQUIRED_KEYS.oidc).toEqual(["account"]);
    expect(REQUIRED_KEYS.bootstrap).toEqual(["account"]);
    expect(REQUIRED_KEYS.deploy).toContain("adminRequiredGroup");
    expect(REQUIRED_KEYS.deploy).toContain("mcpRequiredGroup");
  });

  test("placeholders fill the account for an oidc synth and report it", () => {
    const config = resolveStageConfig({
      stage: "production",
      scope: "oidc",
      values: {},
      placeholders: true,
    });
    expect(config.account).toBe("000000000000");
    expect(config.placeholders).toEqual(["account"]);
  });
});

describe("one stage per account", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-accounts-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("two stages that name the same account conflict, and placeholders and blanks do not", () => {
    expect(
      accountConflicts([
        { stage: "production", account: "123456789012" },
        { stage: "staging", account: "123456789012" },
      ]),
    ).toEqual([
      "stages production and staging name the same account 123456789012; V1 supports one stage per AWS account, so give each stage its own account",
    ]);
    expect(
      accountConflicts([
        { stage: "production", account: "123456789012" },
        { stage: "staging", account: "210987654321" },
      ]),
    ).toEqual([]);
    expect(
      accountConflicts([
        { stage: "production", account: "000000000000" },
        { stage: "staging", account: "000000000000" },
      ]),
    ).toEqual([]);
    expect(
      accountConflicts([
        { stage: "production", account: "123456789012" },
        { stage: "staging", account: undefined },
      ]),
    ).toEqual([]);
  });

  test("loading a stage fails when another stage file names its account", () => {
    writeFileSync(
      stageFile("staging", dir),
      JSON.stringify({ account: "123456789012" }),
    );
    expect(() =>
      loadStageConfig({
        stage: "production",
        scope: "oidc",
        placeholders: false,
        env: {
          SUPPORT_STAGE_CONFIG: JSON.stringify({ account: "123456789012" }),
        },
        dir,
      }),
    ).toThrow("one stage per AWS account");
    const config = loadStageConfig({
      stage: "production",
      scope: "oidc",
      placeholders: false,
      env: {
        SUPPORT_STAGE_CONFIG: JSON.stringify({ account: "210987654321" }),
      },
      dir,
    });
    expect(config.account).toBe("210987654321");
  });

  test("a synth with placeholders is not blocked by the conflict guard", () => {
    const config = loadStageConfig({
      stage: "production",
      scope: "oidc",
      placeholders: true,
      env: {},
      dir,
    });
    expect(config.account).toBe("000000000000");
  });
});

describe("the OIDC-only app", () => {
  test("a stage file with only the account builds the OIDC stack and nothing else", () => {
    const config = loadStageConfig({
      stage: "production",
      scope: "oidc",
      placeholders: false,
      env: {
        SUPPORT_STAGE_CONFIG: JSON.stringify({ account: "123456789012" }),
      },
    });
    const app = new App();
    const stack = createOidcStack(app, config);
    expect(app.node.children.map((child) => child.node.id)).toEqual([
      "PwSupportGithubOidc",
    ]);
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::IAM::OIDCProvider", 1);
    template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "pw-support-production-role-boundary",
    });
    const role = Object.values(template.findResources("AWS::IAM::Role"))[0];
    expect(JSON.stringify(role?.Properties.Tags)).toContain("pw-support:stage");
  });
});
