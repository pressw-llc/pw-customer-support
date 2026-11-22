import { readFileSync } from "node:fs";
import { resolveStackEnv } from "@pw-support/contracts";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Options, type Sql } from "postgres";
import {
  type CredentialsProvider,
  createCredentialsProvider,
  secretsManagerFetcher,
} from "./credentials";
import * as schema from "./schema";

export type SupportDb = ReturnType<typeof drizzle<typeof schema>>;
export type SupportTx = Parameters<Parameters<SupportDb["transaction"]>[0]>[0];
export type SupportExecutor = SupportDb | SupportTx;

export function inTransaction<T>(
  executor: SupportExecutor,
  fn: (tx: SupportTx) => Promise<T>,
): Promise<T> {
  return "rollback" in executor
    ? fn(executor)
    : (executor as SupportDb).transaction(fn);
}

export function localDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStackEnv({ ...env, DATABASE_URL: undefined }).databaseUrl;
}

export function resolveDatabaseUrl(
  url?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return url ?? resolveStackEnv(env).databaseUrl;
}

export const DEFAULT_RDS_CA_PATH = "/etc/ssl/rds/us-east-1-bundle.pem";

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

export type ConnectionPlan =
  | { kind: "url"; url: string }
  | {
      kind: "secret";
      secretId: string;
      host: string;
      port: number;
      database: string;
      user: string;
      caPath: string;
    };

export function connectionPlan(
  env: NodeJS.ProcessEnv = process.env,
  url?: string,
): ConnectionPlan {
  const production = env.NODE_ENV === "production";
  if (production) {
    if (url || env.DATABASE_URL) {
      throw new DatabaseConfigError(
        "DATABASE_URL is not allowed in production; set DB_SECRET_ARN and DB_HOST so the connection verifies the server certificate",
      );
    }
    const missing = ["DB_SECRET_ARN", "DB_HOST"].filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new DatabaseConfigError(
        `${missing.join(" and ")} must be set in production`,
      );
    }
  }
  if (!url && !env.DATABASE_URL && env.DB_SECRET_ARN && env.DB_HOST) {
    return {
      kind: "secret",
      secretId: env.DB_SECRET_ARN,
      host: env.DB_HOST,
      port: Number(env.DB_PORT) || 5432,
      database: env.DB_NAME || "support",
      user: env.DB_USER || "support",
      caPath: env.RDS_CA_BUNDLE_PATH || DEFAULT_RDS_CA_PATH,
    };
  }
  return { kind: "url", url: resolveDatabaseUrl(url, env) };
}

export interface SecretConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  provider: CredentialsProvider;
  ssl: Options<Record<string, never>>["ssl"];
  extra?: Options<Record<string, never>>;
}

export function secretConnectionOptions(
  connection: SecretConnection,
): Options<Record<string, never>> {
  const { provider } = connection;
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    username: connection.user,
    password: async () => {
      provider.noteAttempt();
      return (await provider.get()).password;
    },
    ssl: connection.ssl,
    onparameter: () => provider.noteAuthenticated(),
    onclose: () => provider.noteClosed(),
    onnotice: () => {},
    ...connection.extra,
  };
}

export function createSql(
  options: {
    url?: string;
    env?: NodeJS.ProcessEnv;
    extra?: Options<Record<string, never>>;
  } = {},
): Sql {
  const env = options.env ?? process.env;
  const plan = connectionPlan(env, options.url);
  if (plan.kind === "url") return postgres(plan.url, options.extra ?? {});
  const provider = createCredentialsProvider({
    fetchSecret: secretsManagerFetcher(plan.secretId),
  });
  return postgres(
    secretConnectionOptions({
      host: plan.host,
      port: plan.port,
      database: plan.database,
      user: plan.user,
      provider,
      ssl: { ca: readFileSync(plan.caPath), rejectUnauthorized: true },
      extra: options.extra,
    }),
  );
}

export function createDb(url?: string): SupportDb {
  return drizzle(createSql({ url }), { schema });
}

export async function closeDb(db: SupportDb): Promise<void> {
  await db.$client.end({ timeout: 5 });
}
