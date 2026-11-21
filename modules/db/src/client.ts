import { resolveStackEnv } from "@pw-support/contracts";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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

export function createDb(url?: string): SupportDb {
  const sql = postgres(resolveDatabaseUrl(url));
  return drizzle(sql, { schema });
}

export async function closeDb(db: SupportDb): Promise<void> {
  await db.$client.end({ timeout: 5 });
}
