import { expect, test } from "bun:test";
import { databaseUrlFromParts, resolveStackEnv } from "./stack-config";

test("defaults derive both urls from the default ports", () => {
  const stack = resolveStackEnv({});
  expect(stack.postgresPort).toBe("5447");
  expect(stack.localstackPort).toBe("4577");
  expect(stack.databaseUrl).toBe(
    "postgres://support:support@127.0.0.1:5447/support",
  );
  expect(stack.awsEndpointUrl).toBe("http://127.0.0.1:4577");
});

test("a port override changes both derived urls", () => {
  const stack = resolveStackEnv({
    SUPPORT_POSTGRES_PORT: "6000",
    SUPPORT_LOCALSTACK_PORT: "6001",
  });
  expect(stack.databaseUrl).toContain("127.0.0.1:6000/support");
  expect(stack.awsEndpointUrl).toBe("http://127.0.0.1:6001");
});

test("an explicit url wins over the port", () => {
  const stack = resolveStackEnv({
    SUPPORT_POSTGRES_PORT: "6000",
    DATABASE_URL: "postgres://x/y",
    AWS_ENDPOINT_URL: "http://aws.example",
  });
  expect(stack.databaseUrl).toBe("postgres://x/y");
  expect(stack.awsEndpointUrl).toBe("http://aws.example");
});

test("an empty string counts as unset", () => {
  const stack = resolveStackEnv({
    SUPPORT_POSTGRES_PORT: "",
    SUPPORT_LOCALSTACK_PORT: "",
    DATABASE_URL: "",
    AWS_ENDPOINT_URL: "",
  });
  expect(stack.postgresPort).toBe("5447");
  expect(stack.databaseUrl).toContain(":5447/");
  expect(stack.awsEndpointUrl).toBe("http://127.0.0.1:4577");
});

test("the local issuer derives from the oidc port", () => {
  expect(resolveStackEnv({}).localIssuer).toBe("http://127.0.0.1:4599/support");
  expect(resolveStackEnv({ SUPPORT_OIDC_PORT: "4594" }).localIssuer).toBe(
    "http://127.0.0.1:4594/support",
  );
});

test("reads process.env when no env is passed", () => {
  expect(resolveStackEnv().postgresPort).toBeTruthy();
});

test("database parts build a TLS url with encoded credentials", () => {
  const env = {
    DB_HOST: "db.internal",
    DB_USER: "support",
    DB_PASSWORD: "p@ss/word:1",
    DB_NAME: "app",
    DB_PORT: "6543",
  };
  expect(databaseUrlFromParts(env)).toBe(
    "postgres://support:p%40ss%2Fword%3A1@db.internal:6543/app?sslmode=require",
  );
  expect(resolveStackEnv(env).databaseUrl).toContain("@db.internal:6543/app");
});

test("database parts default the port and name and need all three core parts", () => {
  expect(
    databaseUrlFromParts({ DB_HOST: "h", DB_USER: "u", DB_PASSWORD: "p" }),
  ).toBe("postgres://u:p@h:5432/support?sslmode=require");
  expect(databaseUrlFromParts({ DB_HOST: "h", DB_USER: "u" })).toBeUndefined();
});

test("an explicit database url wins over the parts", () => {
  const stack = resolveStackEnv({
    DATABASE_URL: "postgres://x/y",
    DB_HOST: "h",
    DB_USER: "u",
    DB_PASSWORD: "p",
  });
  expect(stack.databaseUrl).toBe("postgres://x/y");
});
