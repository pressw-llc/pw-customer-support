import { describe, expect, test } from "bun:test";
import { hydrateDatabaseEnv } from "./db-secret";

const secret = JSON.stringify({
  username: "support",
  password: "p",
  host: "db.internal",
  port: 5432,
  dbname: "support",
});

describe("hydrateDatabaseEnv", () => {
  test("copies the secret into the database environment", async () => {
    const env: Record<string, string | undefined> = { DB_SECRET_ARN: "arn:x" };
    await hydrateDatabaseEnv(env, async (id) => {
      expect(id).toBe("arn:x");
      return secret;
    });
    expect(env).toMatchObject({
      DB_USER: "support",
      DB_PASSWORD: "p",
      DB_HOST: "db.internal",
      DB_PORT: "5432",
      DB_NAME: "support",
    });
  });

  test("keeps explicit host settings", async () => {
    const env: Record<string, string | undefined> = {
      DB_SECRET_ARN: "arn:x",
      DB_HOST: "proxy.internal",
    };
    await hydrateDatabaseEnv(env, async () => secret);
    expect(env.DB_HOST).toBe("proxy.internal");
  });

  test("does nothing without a secret id or when the password is set", async () => {
    const fetchSecret = async () => {
      throw new Error("must not fetch");
    };
    await hydrateDatabaseEnv({}, fetchSecret);
    await hydrateDatabaseEnv(
      { DB_SECRET_ARN: "arn:x", DB_PASSWORD: "set" },
      fetchSecret,
    );
  });

  test("rejects an empty secret or one without credentials", async () => {
    const env = { DB_SECRET_ARN: "arn:x" };
    await expect(
      hydrateDatabaseEnv({ ...env }, async () => undefined),
    ).rejects.toThrow("empty");
    await expect(
      hydrateDatabaseEnv({ ...env }, async () => "{}"),
    ).rejects.toThrow("no credentials");
  });

  test("tolerates a secret without host details", async () => {
    const env: Record<string, string | undefined> = { DB_SECRET_ARN: "arn:x" };
    await hydrateDatabaseEnv(env, async () =>
      JSON.stringify({ username: "u", password: "p" }),
    );
    expect(env.DB_HOST).toBeUndefined();
    expect(env.DB_PORT).toBeUndefined();
  });
});
