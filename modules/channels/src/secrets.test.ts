import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { INTEGRATIONS, secretId } from "@pw-support/contracts";
import {
  closeDb,
  createDb,
  integrations,
  migrate,
  recordIntegration,
} from "@pw-support/db";
import { eq } from "drizzle-orm";
import { createLinearWebhookIntake } from "./linear/webhook";
import {
  createManagedSecrets,
  createSecretsManagerClient,
  createSecretWriter,
} from "./secrets";
import { signLinearWebhook } from "./testing/sign";

const db = createDb();
const client = createSecretsManagerClient();
const writer = createSecretWriter(client);
const scope = `t-${crypto.randomUUID().slice(0, 8)}`;
const actor = { sub: "staff", email: "ada@pressw.test", name: null };
const linear = INTEGRATIONS.linear_api_key.secretName;

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.delete(integrations).where(eq(integrations.scope, scope));
  client.destroy();
  await closeDb(db);
});

async function stored(name: string): Promise<string | undefined> {
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretId(scope, name) }),
  );
  return result.SecretString;
}

describe("secret writer", () => {
  test("creates a missing secret and replaces its value on the next put", async () => {
    const ref = await writer.put(scope, linear, "first-value");
    expect(ref).toBe(secretId(scope, linear));
    expect(await stored(linear)).toBe("first-value");
    await writer.put(scope, linear, "second-value");
    expect(await stored(linear)).toBe("second-value");
  });

  test("rethrows an error that is not a missing secret", async () => {
    await expect(writer.put(scope, "bad name!", "")).rejects.toThrow();
  });
});

describe("managed secrets", () => {
  test("reads the stored secret through the Postgres reference and caches it", async () => {
    await writer.put(scope, linear, "managed-value");
    await recordIntegration(
      db,
      { scope, kind: "linear_api_key", secretRef: secretId(scope, linear) },
      actor,
    );
    let clock = 1_000;
    const secrets = createManagedSecrets({
      db,
      client,
      env: {},
      scope,
      ttlMs: 100,
      now: () => clock,
    });
    expect(await secrets.get(linear)).toBe("managed-value");
    await client.send(
      new PutSecretValueCommand({
        SecretId: secretId(scope, linear),
        SecretString: "rotated",
      }),
    );
    expect(await secrets.get(linear)).toBe("managed-value");
    clock += 101;
    expect(await secrets.get(linear)).toBe("rotated");
    await client.send(
      new PutSecretValueCommand({
        SecretId: secretId(scope, linear),
        SecretString: "again",
      }),
    );
    secrets.invalidate(linear);
    expect(await secrets.get(linear)).toBe("again");
    secrets.invalidate();
    expect(await secrets.get(linear)).toBe("again");
  });

  test("falls back to the environment when no reference exists", async () => {
    const secrets = createManagedSecrets({
      db,
      client,
      env: { TYPESAFE_API_KEY: "from-env" },
      scope,
    });
    expect(await secrets.get(INTEGRATIONS.typesafe_api_key.secretName)).toBe(
      "from-env",
    );
    await expect(
      secrets.get(INTEGRATIONS.linear_webhook_secret.secretName),
    ).rejects.toThrow(/not configured/);
    await expect(secrets.get("unknown-name")).rejects.toThrow(/not configured/);
  });

  test("fails loudly when a referenced secret is missing", async () => {
    await recordIntegration(
      db,
      {
        scope,
        kind: "typesafe_api_key",
        secretRef: secretId(scope, "does-not-exist"),
      },
      actor,
    );
    const secrets = createManagedSecrets({
      db,
      client,
      env: { TYPESAFE_API_KEY: "from-env" },
      scope,
    });
    await expect(
      secrets.get(INTEGRATIONS.typesafe_api_key.secretName),
    ).rejects.toThrow();
  });

  test("fails when the stored secret is empty", async () => {
    await writer.put(scope, INTEGRATIONS.linear_webhook_secret.secretName, "x");
    await recordIntegration(
      db,
      {
        scope,
        kind: "linear_webhook_secret",
        secretRef: secretId(
          scope,
          INTEGRATIONS.linear_webhook_secret.secretName,
        ),
      },
      actor,
    );
    const empty = createManagedSecrets({
      db,
      client: {
        send: async () => ({ SecretString: undefined }),
      } as never,
      scope,
    });
    await expect(
      empty.get(INTEGRATIONS.linear_webhook_secret.secretName),
    ).rejects.toThrow(/empty/);
  });
});

describe("the Linear webhook secret comes from the shared provider", () => {
  const raw = () =>
    new TextEncoder().encode(
      JSON.stringify({
        action: "create",
        type: "Issue",
        webhookTimestamp: Date.now(),
      }),
    );

  function request(secret: string) {
    const body = raw();
    return {
      rawBody: body,
      signature: signLinearWebhook(secret, new TextDecoder().decode(body)),
      delivery: crypto.randomUUID(),
    };
  }

  test("verifies against the Secrets Manager value and falls back to the environment", async () => {
    const own = `t-${crypto.randomUUID().slice(0, 8)}`;
    const name = INTEGRATIONS.linear_webhook_secret.secretName;
    await writer.put(own, name, "stored-secret");
    await recordIntegration(
      db,
      {
        scope: own,
        kind: "linear_webhook_secret",
        secretRef: secretId(own, name),
      },
      actor,
    );
    try {
      const stored = createLinearWebhookIntake({
        db,
        secrets: createManagedSecrets({
          db,
          client,
          env: { LINEAR_WEBHOOK_SECRET: "env-secret" },
          scope: own,
        }),
      });
      expect((await stored.handle(request("stored-secret"))).status).toBe(200);
      expect((await stored.handle(request("env-secret"))).status).toBe(401);

      const fallback = createLinearWebhookIntake({
        db,
        secrets: createManagedSecrets({
          db,
          client,
          env: { LINEAR_WEBHOOK_SECRET: "env-secret" },
          scope: `t-${crypto.randomUUID().slice(0, 8)}`,
        }),
      });
      expect((await fallback.handle(request("env-secret"))).status).toBe(200);
    } finally {
      await db.delete(integrations).where(eq(integrations.scope, own));
    }
  });

  test("fails closed when neither Secrets Manager nor the environment has a secret", async () => {
    const intake = createLinearWebhookIntake({
      db,
      secrets: createManagedSecrets({
        db,
        client,
        env: {},
        scope: `t-${crypto.randomUUID().slice(0, 8)}`,
      }),
    });
    const result = await intake.handle(request("anything"));
    expect(result.status).toBe(503);
  });
});

describe("secrets manager client", () => {
  test("uses the stack endpoint locally and the default chain in production", async () => {
    const local = createSecretsManagerClient({
      SUPPORT_LOCALSTACK_PORT: "4584",
    });
    expect((await local.config.endpoint?.())?.hostname).toBe("127.0.0.1");
    local.destroy();
    const production = createSecretsManagerClient({ NODE_ENV: "production" });
    expect(production.config.endpoint).toBeUndefined();
    production.destroy();
  });
});
