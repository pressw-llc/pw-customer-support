import { INTEGRATIONS, resolveSecretsScope } from "@pw-support/contracts";
import { createDb, type SupportDb } from "@pw-support/db";
import { createLinearAdapter, type LinearAdapter } from "./linear/adapter";
import {
  createLinearClient,
  type LinearClient,
  type SecretsProvider,
} from "./linear/client";
import { createJevWordingScorer, type WordingScorer } from "./reply/wording";
import { createManagedSecrets, createSecretsManagerClient } from "./secrets";

type EnvLike = Record<string, string | undefined>;

export function linearApiUrlFor(env: EnvLike): string | undefined {
  return env.NODE_ENV === "production"
    ? undefined
    : env.LINEAR_API_URL || undefined;
}

export function wordingScorerFor(
  env: EnvLike,
  secrets?: SecretsProvider,
): WordingScorer | null {
  const envKey = env.TYPESAFE_API_KEY;
  if (!envKey && !secrets) return null;
  const timeout = Number(env.JEV_TIMEOUT_MS);
  return createJevWordingScorer({
    apiKey: secrets
      ? () => secrets.get(INTEGRATIONS.typesafe_api_key.secretName)
      : (envKey as string),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
  });
}

export interface AdapterRuntime {
  db: SupportDb;
  linear: LinearClient;
  linearAdapter: LinearAdapter;
}

export function createAdapterRuntime(
  env: EnvLike = process.env,
  overrides: {
    db?: SupportDb;
    secrets?: SecretsProvider;
    wording?: WordingScorer | null;
  } = {},
): AdapterRuntime {
  const db = overrides.db ?? createDb();
  const secrets =
    overrides.secrets ??
    createManagedSecrets({
      db,
      client: createSecretsManagerClient(env),
      env,
      scope: resolveSecretsScope(env),
    });
  const linear = createLinearClient({
    secrets,
    apiUrl: linearApiUrlFor(env),
  });
  const wording =
    overrides.wording === undefined
      ? wordingScorerFor(env, secrets)
      : overrides.wording;
  return {
    db,
    linear,
    linearAdapter: createLinearAdapter({ db, linear, wording }),
  };
}

let shared: AdapterRuntime | undefined;

export function getAdapterRuntime(): AdapterRuntime {
  shared ??= createAdapterRuntime();
  return shared;
}

export function setAdapterRuntime(runtime: AdapterRuntime | undefined): void {
  shared = runtime;
}
