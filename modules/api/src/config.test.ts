import { expect, test } from "bun:test";
import {
  adminPolicyMissing,
  loadConfig,
  mcpAuthConfig,
  productionConfigErrors,
  productionStartupProblems,
} from "./config";

test("defaults target the local Compose stack", () => {
  const config = loadConfig({});
  expect(config.port).toBe(8787);
  expect(config.bucket).toBe("pw-support-attachments");
  expect(config.s3.endpoint).toBe("http://127.0.0.1:4577");
  expect(config.s3.credentials).toEqual({
    accessKeyId: "test",
    secretAccessKey: "test",
  });
  expect(config.rateLimit).toEqual({
    windowSeconds: 60,
    perKey: 600,
    perUser: 120,
  });
  expect(config.maxBodyBytes).toBe(10 * 25 * 1024 * 1024 + 1024 * 1024);
});

test("environment values override the defaults", () => {
  const config = loadConfig({
    API_PORT: "9000",
    ATTACHMENTS_BUCKET: "bucket-x",
    RATE_LIMIT_PER_USER: "7",
    RATE_LIMIT_PER_KEY: "70",
    RATE_LIMIT_WINDOW_SECONDS: "5",
    MAX_REQUEST_BYTES: "1000",
    SUPPORT_LOCALSTACK_PORT: "4999",
  });
  expect(config.port).toBe(9000);
  expect(config.bucket).toBe("bucket-x");
  expect(config.rateLimit).toEqual({
    windowSeconds: 5,
    perKey: 70,
    perUser: 7,
  });
  expect(config.maxBodyBytes).toBe(1000);
  expect(config.s3.endpoint).toBe("http://127.0.0.1:4999");
});

test("invalid numbers fall back to the defaults", () => {
  const config = loadConfig({ API_PORT: "abc", RATE_LIMIT_PER_USER: "-3" });
  expect(config.port).toBe(8787);
  expect(config.rateLimit.perUser).toBe(120);
});

test("production uses the AWS default endpoint and credential chain", () => {
  const config = loadConfig({ NODE_ENV: "production" });
  expect(config.s3.endpoint).toBeUndefined();
  expect(config.s3.credentials).toBeUndefined();
});

test("an explicit endpoint and credentials win", () => {
  const config = loadConfig({
    AWS_ENDPOINT_URL: "http://s3.example",
    AWS_ACCESS_KEY_ID: "id",
    AWS_SECRET_ACCESS_KEY: "secret",
    AWS_REGION: "eu-west-1",
  });
  expect(config.s3).toEqual({
    region: "eu-west-1",
    endpoint: "http://s3.example",
    credentials: { accessKeyId: "id", secretAccessKey: "secret" },
  });
});

test("local auth defaults to the mock issuer and its client id", () => {
  const config = loadConfig({ SUPPORT_OIDC_PORT: "4594" });
  expect(config.auth.issuer).toBe("http://127.0.0.1:4594/support");
  expect(config.auth.audiences).toEqual(["pw-support-admin"]);
  expect(config.adminOrigins).toEqual([
    "http://127.0.0.1:5183",
    "http://localhost:5183",
  ]);
  expect(config.secretsScope).toBe("global");
  expect(config.admin).toEqual({ maxBodyBytes: 16384, mutationsPerWindow: 60 });
});

test("production auth has no default and fails closed", () => {
  const config = loadConfig({ NODE_ENV: "production" });
  expect(config.auth.issuer).toBeUndefined();
  expect(config.auth.audiences).toEqual([]);
  expect(config.adminOrigins).toEqual([]);
});

test("auth settings come from the environment", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    COGNITO_ISSUER: "https://idp.example/pool",
    COGNITO_AUDIENCE: "client-a, client-b",
    ADMIN_ALLOWED_EMAIL_DOMAINS: "PressW.test, other.test",
    ADMIN_REQUIRED_GROUP: "staff",
    ADMIN_ORIGINS: "https://admin.example, https://admin2.example",
    ADMIN_MAX_BODY_BYTES: "512",
    ADMIN_RATE_LIMIT_PER_WINDOW: "5",
    SECRETS_SCOPE: "acme",
    AUTH_FETCH_TIMEOUT_MS: "900",
  });
  expect(config.auth).toEqual({
    issuer: "https://idp.example/pool",
    audiences: ["client-a", "client-b"],
    allowedEmailDomains: ["pressw.test", "other.test"],
    requiredGroup: "staff",
    clockToleranceSeconds: 30,
    fetchTimeoutMs: 900,
  });
  expect(config.adminOrigins).toEqual([
    "https://admin.example",
    "https://admin2.example",
  ]);
  expect(config.admin).toEqual({ maxBodyBytes: 512, mutationsPerWindow: 5 });
  expect(config.secretsScope).toBe("acme");
  expect(loadConfig({ ADMIN_DEV_PORT: "6000" }).adminOrigins[0]).toBe(
    "http://127.0.0.1:6000",
  );
});

test("the mcp auth config drops the admin email domains and takes its own group", () => {
  const config = loadConfig({
    ADMIN_ALLOWED_EMAIL_DOMAINS: "pressw.test",
    ADMIN_REQUIRED_GROUP: "admins",
    MCP_REQUIRED_GROUP: "engineers",
  });
  expect(config.auth.allowedEmailDomains).toEqual(["pressw.test"]);
  expect(mcpAuthConfig(config).allowedEmailDomains).toEqual([]);
  expect(mcpAuthConfig(config).requiredGroup).toBe("engineers");
  expect(mcpAuthConfig(loadConfig({})).requiredGroup).toBeUndefined();
});

test("production without MCP_AUDIENCE or MCP_REQUIRED_GROUP disables mcp with no admin audience fallback", () => {
  const base = {
    NODE_ENV: "production",
    COGNITO_ISSUER: "https://idp.example",
    COGNITO_AUDIENCE: "admin-client",
  };
  const none = loadConfig(base);
  expect(none.mcp.disabled).toBe(true);
  expect(none.mcp.audiences).toEqual([]);
  expect(loadConfig({ ...base, MCP_AUDIENCE: "mcp-client" }).mcp.disabled).toBe(
    true,
  );
  expect(
    loadConfig({ ...base, MCP_REQUIRED_GROUP: "engineers" }).mcp.disabled,
  ).toBe(true);
  const ready = loadConfig({
    ...base,
    MCP_AUDIENCE: "mcp-client",
    MCP_REQUIRED_GROUP: "engineers",
  });
  expect(ready.mcp.disabled).toBeUndefined();
  expect(ready.mcp.audiences).toEqual(["mcp-client"]);
});

test("outside production mcp keeps the admin audience fallback and stays enabled", () => {
  const config = loadConfig({ COGNITO_AUDIENCE: "admin-client" });
  expect(config.mcp.disabled).toBeUndefined();
  expect(config.mcp.audiences).toContain("admin-client");
});

test("productionConfigErrors names each missing setting once and no secret", () => {
  const production = { NODE_ENV: "production", ADMIN_REQUIRED_GROUP: "staff" };
  const errors = productionConfigErrors(production);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("MCP_AUDIENCE and MCP_REQUIRED_GROUP");
  const audienceOnly = { ...production, MCP_AUDIENCE: "mcp-client" };
  expect(productionConfigErrors(audienceOnly)[0]).toContain(
    "MCP_REQUIRED_GROUP must",
  );
  const ready = { ...audienceOnly, MCP_REQUIRED_GROUP: "engineers" };
  expect(productionConfigErrors(ready)).toEqual([]);
  expect(productionConfigErrors({})).toEqual([]);
});

test("production without an admin group or email domain disables /admin and reports one error", () => {
  const production = {
    NODE_ENV: "production",
    MCP_AUDIENCE: "m",
    MCP_REQUIRED_GROUP: "engineers",
  };
  expect(adminPolicyMissing(production)).toBe(true);
  expect(loadConfig(production).admin.disabled).toBe(true);
  const errors = productionConfigErrors(production);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(
    "ADMIN_REQUIRED_GROUP or ADMIN_ALLOWED_EMAIL_DOMAINS",
  );
});

test("a group or an email domain enables /admin in production, and development is unchanged", () => {
  const production = { NODE_ENV: "production" };
  for (const policy of [
    { ADMIN_REQUIRED_GROUP: "staff" },
    { ADMIN_ALLOWED_EMAIL_DOMAINS: "pressw.com" },
  ]) {
    expect(adminPolicyMissing({ ...production, ...policy })).toBe(false);
    expect(
      loadConfig({ ...production, ...policy }).admin.disabled,
    ).toBeUndefined();
  }
  expect(
    adminPolicyMissing({ ...production, ADMIN_ALLOWED_EMAIL_DOMAINS: " , " }),
  ).toBe(true);
  expect(adminPolicyMissing({})).toBe(false);
  expect(loadConfig({}).admin.disabled).toBeUndefined();
});

test("production startup refuses to run without the stack's names and database settings", () => {
  expect(productionStartupProblems({})).toEqual([]);
  expect(productionStartupProblems({ NODE_ENV: "development" })).toEqual([]);
  const problems = productionStartupProblems({ NODE_ENV: "production" });
  for (const name of [
    "ATTACHMENTS_BUCKET",
    "SUPPORT_STAGE",
    "TRIAGE_WAKE_QUEUE",
    "DB_SECRET_ARN",
    "DB_HOST",
  ]) {
    expect(problems.join("\n")).toContain(`${name} must be set in production`);
  }
  const ready = {
    NODE_ENV: "production",
    ATTACHMENTS_BUCKET: "b",
    SUPPORT_STAGE: "production",
    TRIAGE_WAKE_QUEUE: "q",
    DB_SECRET_ARN: "arn",
    DB_HOST: "h",
  };
  expect(productionStartupProblems(ready)).toEqual([]);
});

test("production startup refuses the local stage, a database URL, and a Linear URL override", () => {
  const ready = {
    NODE_ENV: "production",
    ATTACHMENTS_BUCKET: "b",
    SUPPORT_STAGE: "local",
    TRIAGE_WAKE_QUEUE: "q",
    DB_SECRET_ARN: "arn",
    DB_HOST: "h",
    DATABASE_URL: "postgres://x/y",
    LINEAR_API_URL: "http://stub",
  };
  const problems = productionStartupProblems(ready).join("\n");
  expect(problems).toContain("not local");
  expect(problems).toContain("DATABASE_URL is not allowed");
  expect(problems).toContain("LINEAR_API_URL must not be set");
});
