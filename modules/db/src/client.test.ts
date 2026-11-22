import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { resolveStackEnv } from "@pw-support/contracts";
import postgres from "postgres";
import {
  connectionPlan,
  createSql,
  DatabaseConfigError,
  DEFAULT_RDS_CA_PATH,
  localDatabaseUrl,
  secretConnectionOptions,
} from "./client";
import {
  createCredentialsProvider,
  isAuthError,
  secretsManagerFetcher,
} from "./credentials";

const production = {
  NODE_ENV: "production",
  DB_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:000000000000:secret:x",
  DB_HOST: "cluster.example.internal",
};

describe("connectionPlan", () => {
  test("uses the local URL outside production and honors an explicit URL", () => {
    expect(connectionPlan({}, undefined)).toEqual({
      kind: "url",
      url: localDatabaseUrl({}),
    });
    expect(connectionPlan({ DATABASE_URL: "postgres://x/y" })).toEqual({
      kind: "url",
      url: "postgres://x/y",
    });
    expect(connectionPlan({}, "postgres://explicit/z")).toEqual({
      kind: "url",
      url: "postgres://explicit/z",
    });
  });

  test("production reads the secret ARN, the host, and the RDS CA path", () => {
    expect(connectionPlan(production)).toEqual({
      kind: "secret",
      secretId: production.DB_SECRET_ARN,
      host: production.DB_HOST,
      port: 5432,
      database: "support",
      user: "support",
      caPath: DEFAULT_RDS_CA_PATH,
    });
    expect(
      connectionPlan({
        ...production,
        DB_PORT: "6543",
        DB_NAME: "app",
        DB_USER: "svc",
        RDS_CA_BUNDLE_PATH: "/ca.pem",
      }),
    ).toMatchObject({
      port: 6543,
      database: "app",
      user: "svc",
      caPath: "/ca.pem",
    });
  });

  test("production refuses a DATABASE_URL because it cannot verify the certificate", () => {
    expect(() =>
      connectionPlan({ ...production, DATABASE_URL: "postgres://x/y" }),
    ).toThrow(DatabaseConfigError);
    expect(() => connectionPlan(production, "postgres://x/y")).toThrow(
      "not allowed in production",
    );
  });

  test("production refuses a missing secret ARN or host", () => {
    expect(() => connectionPlan({ NODE_ENV: "production" })).toThrow(
      "DB_SECRET_ARN and DB_HOST must be set in production",
    );
    expect(() =>
      connectionPlan({ NODE_ENV: "production", DB_HOST: "h" }),
    ).toThrow("DB_SECRET_ARN must be set");
  });

  test("production fails to connect without the CA bundle file", () => {
    expect(() =>
      createSql({ env: { ...production, RDS_CA_BUNDLE_PATH: "/missing.pem" } }),
    ).toThrow();
  });

  test("production builds a verified TLS client from a CA bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-ca-"));
    const ca = join(dir, "ca.pem");
    writeFileSync(
      ca,
      "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n",
    );
    try {
      const sql = createSql({ env: { ...production, RDS_CA_BUNDLE_PATH: ca } });
      expect(sql.options.ssl).toMatchObject({ rejectUnauthorized: true });
      expect(sql.options.host).toEqual([production.DB_HOST]);
      expect(typeof sql.options.pass).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("password rotation against Postgres and Secrets Manager", () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const role = `rot_${suffix}`;
  const secretId = `pw-support-test/rotation-${suffix}`;
  const stack = resolveStackEnv(process.env);
  const sm = new SecretsManagerClient({
    endpoint: stack.awsEndpointUrl,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const admin = postgres(stack.databaseUrl, { max: 1, onnotice: () => {} });
  const secretString = (password: string) =>
    JSON.stringify({ username: role, password });

  afterAll(async () => {
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end({ timeout: 2 });
    await sm
      .send(
        new DeleteSecretCommand({
          SecretId: secretId,
          ForceDeleteWithoutRecovery: true,
        }),
      )
      .catch(() => {});
    sm.destroy();
  });

  test("a new connection succeeds after the password and the secret change, with no restart", async () => {
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'first-pass'`);
    await admin.unsafe(`GRANT CONNECT ON DATABASE support TO ${role}`);
    await sm.send(
      new CreateSecretCommand({
        Name: secretId,
        SecretString: secretString("first-pass"),
      }),
    );
    const url = new URL(stack.databaseUrl);
    const provider = createCredentialsProvider({
      fetchSecret: secretsManagerFetcher(secretId, sm),
    });
    const sql = postgres(
      secretConnectionOptions({
        host: url.hostname,
        port: Number(url.port),
        database: "support",
        user: role,
        provider,
        ssl: false,
        extra: { max: 1, idle_timeout: undefined },
      }),
    );
    try {
      expect((await sql`SELECT current_user AS who`)[0]?.who).toBe(role);

      await admin.unsafe(`ALTER ROLE ${role} PASSWORD 'second-pass'`);
      await sm.send(
        new PutSecretValueCommand({
          SecretId: secretId,
          SecretString: secretString("second-pass"),
        }),
      );
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${role}`;

      const failures: unknown[] = [];
      let who: string | undefined;
      for (let attempt = 0; attempt < 4 && who === undefined; attempt++) {
        try {
          who = (await sql`SELECT current_user AS who`)[0]?.who;
        } catch (error) {
          failures.push(error);
          await Bun.sleep(50);
        }
      }
      expect(who).toBe(role);
      expect(failures.length).toBeLessThanOrEqual(2);
      for (const failure of failures) {
        const ok =
          isAuthError(failure) ||
          (failure as { code?: string }).code === "CONNECTION_ENDED" ||
          (failure as { code?: string }).code === "CONNECTION_CLOSED";
        expect(ok).toBe(true);
      }
    } finally {
      await sql.end({ timeout: 2 });
    }
  }, 30_000);
});
