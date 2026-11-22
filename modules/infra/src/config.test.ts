import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  isStageName,
  type RawValues,
  resolveStageConfig,
  stageValuesFrom,
} from "./config";
import {
  loadStageConfig,
  loadStageValues,
  parseJsonObject,
  parseStage,
  stageFile,
} from "./load-config";

const complete: RawValues = {
  account: "123456789012",
  cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_X",
  adminClientId: "admin-id",
  mcpClientId: "mcp-id",
  mcpRequiredGroup: "staff",
  adminRequiredGroup: "admins",
  certificateArn:
    "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555",
  apiDomain: "api.example.com",
  triageAgentId: "agent_1",
};

function problems(input: Parameters<typeof resolveStageConfig>[0]): string[] {
  try {
    resolveStageConfig(input);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("resolveStageConfig", () => {
  test("accepts a complete production config without placeholders", () => {
    const config = resolveStageConfig({
      stage: "production",
      values: complete,
      placeholders: false,
    });
    expect(config.account).toBe("123456789012");
    expect(config.region).toBe("us-east-1");
    expect(config.placeholders).toEqual([]);
    expect(config.extraAdminOrigins).toEqual([]);
  });

  test("lists every missing production value with a hint when placeholders are off", () => {
    const found = problems({
      stage: "production",
      values: {},
      placeholders: false,
    });
    for (const key of [
      "account",
      "cognitoIssuer",
      "adminClientId",
      "mcpClientId",
      "mcpRequiredGroup",
      "adminRequiredGroup",
      "certificateArn",
      "apiDomain",
      "triageAgentId",
    ]) {
      expect(found.some((line) => line.startsWith(`${key} is required`))).toBe(
        true,
      );
    }
  });

  test("states the problems in the error message", () => {
    expect(() =>
      resolveStageConfig({
        stage: "production",
        values: {},
        placeholders: false,
      }),
    ).toThrow("stage configuration is incomplete");
  });

  test("makes the certificate, domain, group, and agent optional for staging", () => {
    const config = resolveStageConfig({
      stage: "staging",
      placeholders: false,
      values: {
        account: "123456789012",
        cognitoIssuer: "https://issuer.example",
        adminClientId: "a",
        mcpClientId: "m",
        adminRequiredGroup: "admins",
      },
    });
    expect(config.certificateArn).toBeUndefined();
    expect(config.mcpRequiredGroup).toBe("");
    expect(config.triageAgentId).toBe("");
  });

  test("rejects malformed values", () => {
    const found = problems({
      stage: "production",
      placeholders: false,
      values: {
        ...complete,
        account: "12",
        cognitoIssuer: "http://insecure",
        certificateArn: "arn:aws:acm:eu-west-1:123456789012:certificate/x",
        adminLogoutUrl: "http://x",
        extraAdminOrigins: "https://ok.example, https://bad.example/path",
      },
    });
    expect(found).toEqual([
      "account must be 12 digits",
      "cognitoIssuer must be an https URL",
      "certificateArn must be an ACM certificate ARN in us-east-1",
      "adminLogoutUrl must be an https URL",
      "admin origin https://bad.example/path must be https with no path",
    ]);
  });

  test("refuses an empty admin group in every stage and lowercases email domains", () => {
    expect(
      problems({
        stage: "production",
        placeholders: true,
        values: { adminRequiredGroup: "" },
      }),
    ).toEqual([
      "adminRequiredGroup must not be empty in production; set the Cognito group that may use /admin",
    ]);
    const config = resolveStageConfig({
      stage: "staging",
      placeholders: true,
      values: { adminAllowedEmailDomains: "PressW.com, Example.org" },
    });
    expect(config.adminAllowedEmailDomains).toEqual([
      "pressw.com",
      "example.org",
    ]);
    expect(
      problems({
        stage: "staging",
        placeholders: false,
        values: {
          account: "123456789012",
          cognitoIssuer: "https://i",
          adminClientId: "a",
          mcpClientId: "m",
        },
      }).some((line) => line.startsWith("adminRequiredGroup is required")),
    ).toBe(true);
  });

  test("refuses an empty required group and a Linear URL in production", () => {
    expect(
      problems({
        stage: "production",
        placeholders: true,
        values: { mcpRequiredGroup: "" },
      }),
    ).toEqual([
      "mcpRequiredGroup must not be empty in production; set the Cognito group that may use /mcp",
    ]);
    expect(
      problems({
        stage: "production",
        placeholders: true,
        values: { linearApiUrl: "http://stub" },
      }),
    ).toEqual(["linearApiUrl cannot be set in production"]);
    expect(
      problems({
        stage: "staging",
        placeholders: true,
        values: { linearApiUrl: "http://stub" },
      }),
    ).toEqual([]);
  });

  test("fills placeholders only for missing values and reports them", () => {
    const config = resolveStageConfig({
      stage: "production",
      placeholders: true,
      values: {
        account: "123456789012",
        extraAdminOrigins: ["https://a.example"],
      },
    });
    expect(config.account).toBe("123456789012");
    expect(config.placeholders).not.toContain("account");
    expect(config.placeholders).toContain("mcpRequiredGroup");
    expect(config.extraAdminOrigins).toEqual(["https://a.example"]);
  });

  test("reads numbers and whitespace as text", () => {
    const config = resolveStageConfig({
      stage: "staging",
      placeholders: true,
      values: { account: 123456789012, alarmEmail: " ops@example.com " },
    });
    expect(config.account).toBe("123456789012");
    expect(config.alarmEmail).toBe("ops@example.com");
  });

  test("recognizes stage names", () => {
    expect(isStageName("production")).toBe(true);
    expect(isStageName("dev")).toBe(false);
  });

  test("merges context over file values", () => {
    const values = stageValuesFrom(
      (key) => (key === "account" ? "999999999999" : undefined),
      { account: "111111111111", apiDomain: "api.example.com" },
    );
    expect(values).toEqual({
      account: "999999999999",
      apiDomain: "api.example.com",
    });
  });
});

describe("load-config", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-infra-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads the stage file, then the environment JSON, then context", () => {
    writeFileSync(
      stageFile("production", dir),
      JSON.stringify({
        account: "111111111111",
        apiDomain: "file.example.com",
      }),
    );
    const values = loadStageValues(
      "production",
      (key) => (key === "apiDomain" ? "context.example.com" : undefined),
      { SUPPORT_STAGE_CONFIG: '{"account":"222222222222"}' },
      dir,
    );
    expect(values).toEqual({
      account: "222222222222",
      apiDomain: "context.example.com",
    });
  });

  test("returns nothing when no source exists", () => {
    expect(loadStageValues("staging", undefined, {}, dir)).toEqual({});
  });

  test("loads a full config from the environment", () => {
    const config = loadStageConfig({
      stage: "production",
      placeholders: false,
      env: { SUPPORT_STAGE_CONFIG: JSON.stringify(complete) },
      dir,
    });
    expect(config.mcpRequiredGroup).toBe("staff");
  });

  test("rejects invalid JSON and non-objects", () => {
    expect(() => parseJsonObject("{", "x")).toThrow("x is not valid JSON");
    expect(() => parseJsonObject("[]", "x")).toThrow("x must be a JSON object");
    expect(() => parseJsonObject("null", "x")).toThrow("must be a JSON object");
  });

  test("parses stage names with a production default", () => {
    expect(parseStage(undefined)).toBe("production");
    expect(parseStage("staging")).toBe("staging");
    expect(() => parseStage("dev")).toThrow('unknown stage "dev"');
  });
});
