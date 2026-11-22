import { expect, test } from "bun:test";
import { loadConfig, mcpAuthConfig } from "./config";

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
