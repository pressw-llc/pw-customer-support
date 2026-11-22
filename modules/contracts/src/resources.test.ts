import { expect, test } from "bun:test";
import { resolveSecretsScope, secretId } from "./admin";
import {
  LOCAL_STAGE,
  RESOURCE_NAMES,
  resourceNames,
  stageFromEnv,
} from "./resources";

test("the local stage keeps the original names", () => {
  expect(RESOURCE_NAMES).toEqual(resourceNames(LOCAL_STAGE));
  expect(RESOURCE_NAMES.triageWakeQueue).toBe("pw-support-triage-wake");
  expect(RESOURCE_NAMES.secretsScope).toBe("global");
});

test("another stage gets stage-specific names for every explicit resource", () => {
  const production = resourceNames("production");
  const staging = resourceNames("staging");
  const keys = [
    "attachmentsBucket",
    "triageWakeQueue",
    "triageWakeDlq",
    "linearAdapterQueue",
    "linearAdapterDlq",
    "databaseSecret",
    "anthropicSecret",
    "githubDeployRole",
    "secretsScope",
  ] as const;
  for (const key of keys) {
    expect(production[key], key).toContain("production");
    expect(production[key]).not.toBe(staging[key]);
  }
  expect(production.secretsPrefix).toBe("pw-support/");
});

test("each stage has its own CDK bootstrap qualifier within the 10 character limit", () => {
  const production = resourceNames("production");
  const staging = resourceNames("staging");
  expect(production.bootstrapQualifier).not.toBe(staging.bootstrapQualifier);
  for (const names of [production, staging]) {
    expect(names.bootstrapQualifier).toMatch(/^[a-z0-9]{9,10}$/);
    expect(names.bootstrapQualifier).not.toBe("hnb659fds");
  }
  expect(production.cfnExecutionPolicy).not.toBe(staging.cfnExecutionPolicy);
});

test("the stage comes from SUPPORT_STAGE and defaults to local", () => {
  expect(stageFromEnv({})).toBe("local");
  expect(stageFromEnv({ SUPPORT_STAGE: "staging" })).toBe("staging");
});

test("the secrets scope follows the stage unless SECRETS_SCOPE overrides it", () => {
  expect(resolveSecretsScope({})).toBe("global");
  expect(resolveSecretsScope({ SUPPORT_STAGE: "production" })).toBe(
    "production",
  );
  expect(
    resolveSecretsScope({
      SUPPORT_STAGE: "production",
      SECRETS_SCOPE: "e2e-1",
    }),
  ).toBe("e2e-1");
  expect(
    secretId(
      resolveSecretsScope({ SUPPORT_STAGE: "staging" }),
      "linear-api-key",
    ),
  ).toBe("pw-support/staging/linear-api-key");
});
