import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type SupportDb = ReturnType<typeof drizzle<typeof schema>>;
type SupportTx = Parameters<Parameters<SupportDb["transaction"]>[0]>[0];
export type SupportExecutor = SupportDb | SupportTx;

const DEFAULT_POSTGRES_PORT = "5447";

export function localDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = env.SUPPORT_POSTGRES_PORT ?? DEFAULT_POSTGRES_PORT;
  return `postgres://support:support@127.0.0.1:${port}/support`;
}

export function resolveDatabaseUrl(
  url?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return url ?? env.DATABASE_URL ?? localDatabaseUrl(env);
}

export function createDb(url?: string): SupportDb {
  const sql = postgres(resolveDatabaseUrl(url));
  return drizzle(sql, { schema });
}

export async function closeDb(db: SupportDb): Promise<void> {
  await db.$client.end({ timeout: 5 });
}
