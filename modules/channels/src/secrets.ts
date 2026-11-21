import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  integrationKindForSecretName,
  resolveStackEnv,
  SECRET_SCOPE_GLOBAL,
  secretId,
} from "@pw-support/contracts";
import { getIntegration, type SupportExecutor } from "@pw-support/db";
import { envSecrets, type SecretsProvider } from "./linear/client";

type EnvLike = Record<string, string | undefined>;

export const SECRETS_CACHE_TTL_MS = 30_000;

export function createSecretsManagerClient(
  env: EnvLike = process.env,
): SecretsManagerClient {
  const local = env.NODE_ENV !== "production";
  return new SecretsManagerClient({
    region: env.AWS_REGION || "us-east-1",
    endpoint: local
      ? resolveStackEnv(env).awsEndpointUrl
      : env.AWS_ENDPOINT_URL || undefined,
    credentials: local
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID || "test",
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY || "test",
        }
      : undefined,
  });
}

export interface SecretWriter {
  put(scope: string, secretName: string, value: string): Promise<string>;
}

export function createSecretWriter(client: SecretsManagerClient): SecretWriter {
  return {
    async put(scope, secretName, value) {
      const name = secretId(scope, secretName);
      try {
        await client.send(
          new PutSecretValueCommand({ SecretId: name, SecretString: value }),
        );
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) throw error;
        await client.send(
          new CreateSecretCommand({ Name: name, SecretString: value }),
        );
      }
      return name;
    },
  };
}

export interface ManagedSecrets extends SecretsProvider {
  invalidate(name?: string): void;
}

export interface ManagedSecretsOptions {
  db: SupportExecutor;
  client: SecretsManagerClient;
  env?: EnvLike;
  scope?: string;
  ttlMs?: number;
  now?: () => number;
}

export function createManagedSecrets(
  options: ManagedSecretsOptions,
): ManagedSecrets {
  const scope = options.scope ?? SECRET_SCOPE_GLOBAL;
  const ttlMs = options.ttlMs ?? SECRETS_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const fallback = envSecrets(options.env ?? process.env);
  const cache = new Map<string, { value: string; expires: number }>();

  async function load(name: string): Promise<string> {
    const kind = integrationKindForSecretName(name);
    const row = kind ? await getIntegration(options.db, scope, kind) : null;
    if (!row) return fallback.get(name);
    const result = await options.client.send(
      new GetSecretValueCommand({ SecretId: row.secretRef }),
    );
    if (!result.SecretString) throw new Error(`secret ${name} is empty`);
    return result.SecretString;
  }

  return {
    async get(name) {
      const hit = cache.get(name);
      if (hit && hit.expires > now()) return hit.value;
      const value = await load(name);
      cache.set(name, { value, expires: now() + ttlMs });
      return value;
    },
    invalidate(name) {
      if (name) cache.delete(name);
      else cache.clear();
    },
  };
}
