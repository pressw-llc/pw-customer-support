import { expect, test } from "bun:test";
import { loadConfig } from "./config";

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
