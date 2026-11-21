import { createDb, type SupportDb } from "@pw-support/db";
import { createLinearAdapter, type LinearAdapter } from "./linear/adapter";
import {
  createLinearClient,
  envSecrets,
  type LinearClient,
  type SecretsProvider,
} from "./linear/client";

type EnvLike = Record<string, string | undefined>;

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
    secrets: overrides.secrets ?? envSecrets(env),
    apiUrl: env.LINEAR_API_URL || undefined,
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
