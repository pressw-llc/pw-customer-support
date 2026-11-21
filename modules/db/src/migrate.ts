import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { resolveDatabaseUrl } from "./client";

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

const LOCK_ID = 7_105_001;

export interface MigrationFile {
  name: string;
  sql: string;
}

function sqlFilesIn(dir: string, prefix: string): MigrationFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name: `${prefix}${name}`,
      sql: readFileSync(join(dir, name), "utf8"),
    }));
}

export function listMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return [
    ...sqlFilesIn(join(dir, "pipeline"), "pipeline/"),
    ...sqlFilesIn(dir, ""),
  ];
}

export async function migrate(
  url?: string,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const sql = postgres(resolveDatabaseUrl(url), {
    max: 1,
    onnotice: () => {},
  });
  const applied: string[] = [];
  try {
    await sql`SELECT pg_advisory_lock(${LOCK_ID})`;
    await sql`CREATE SCHEMA IF NOT EXISTS support`;
    await sql`CREATE TABLE IF NOT EXISTS support.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const done = new Set(
      (
        await sql<
          { name: string }[]
        >`SELECT name FROM support.schema_migrations`
      ).map((row) => row.name),
    );
    for (const file of listMigrations(dir)) {
      if (done.has(file.name)) continue;
      await sql.begin(async (tx) => {
        if (file.name.startsWith("pipeline/")) {
          await tx.unsafe("SET LOCAL search_path TO public");
        }
        await tx.unsafe(file.sql);
        await tx`INSERT INTO support.schema_migrations (name) VALUES (${file.name})`;
      });
      applied.push(file.name);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_ID})`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
  return applied;
}
