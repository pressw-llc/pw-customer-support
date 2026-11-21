import { resolveSecretsScope } from "@pw-support/contracts";
import { createDb, type SupportDb } from "@pw-support/db";
import { createLinearAdapter, type LinearAdapter } from "./linear/adapter";
import {
  createLinearClient,
  type LinearClient,
  type SecretsProvider,
} from "./linear/client";
import { createManagedSecrets, createSecretsManagerClient } from "./secrets";

type EnvLike = Record<string, string | undefined>;

export function linearApiUrlFor(env: EnvLike): string | undefined {
  return env.NODE_ENV === "production"
    ? undefined
    : env.LINEAR_API_URL || undefined;
}

export interface AdapterRuntime {
  db: SupportDb;
  linear: LinearClient;
  linearAdapter: LinearAdapter;
}

export function createAdapterRuntime(
  env: EnvLike = process.env,
  overrides: { db?: SupportDb; secrets?: SecretsProvider } = {},
): AdapterRuntime {
  const db = overrides.db ?? createDb();
  const linear = createLinearClient({
    secrets:
      overrides.secrets ??
      createManagedSecrets({
        db,
        client: createSecretsManagerClient(env),
        env,
        scope: resolveSecretsScope(env),
      }),
    apiUrl: linearApiUrlFor(env),
  });
  return { db, linear, linearAdapter: createLinearAdapter({ db, linear }) };
}

let shared: AdapterRuntime | undefined;

export function getAdapterRuntime(): AdapterRuntime {
  shared ??= createAdapterRuntime();
  return shared;
}

export function setAdapterRuntime(runtime: AdapterRuntime | undefined): void {
  shared = runtime;
}
