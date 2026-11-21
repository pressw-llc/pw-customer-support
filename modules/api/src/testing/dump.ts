import { resolveStackEnv } from "@pw-support/contracts";
import postgres from "postgres";

export interface DatabaseDump {
  method: "pg_dump" | "sql";
  text: string;
}

type EnvLike = Record<string, string | undefined>;

function postgresContainer(env: EnvLike, docker: string): string | undefined {
  const port = resolveStackEnv(env).postgresPort;
  try {
    const found = Bun.spawnSync([
      docker,
      "ps",
      "--filter",
      `publish=${port}`,
      "--format",
      "{{.Names}}",
    ]);
    const name = found.stdout.toString().trim().split("\n")[0];
    return found.exitCode === 0 && name ? name : undefined;
  } catch {
    return undefined;
  }
}

function pgDump(docker: string, container: string): string | undefined {
  const dump = Bun.spawnSync([
    docker,
    "exec",
    container,
    "pg_dump",
    "-U",
    "support",
    "support",
  ]);
  return dump.exitCode === 0 ? dump.stdout.toString() : undefined;
}

async function sqlDump(env: EnvLike): Promise<string> {
  const sql = postgres(resolveStackEnv(env).databaseUrl, { max: 1 });
  try {
    const tables = await sql<{ schema: string; name: string }[]>`
      select table_schema as schema, table_name as name
      from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema not in ('pg_catalog', 'information_schema')`;
    const parts: string[] = [];
    for (const table of tables) {
      const rows = await sql.unsafe(
        `select row_to_json(t)::text as row from "${table.schema}"."${table.name}" t`,
      );
      parts.push(
        ...rows.map((row) => `${table.schema}.${table.name} ${row.row}`),
      );
    }
    return parts.join("\n");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function dumpDatabase(
  options: { env?: EnvLike; forceSql?: boolean; docker?: string } = {},
): Promise<DatabaseDump> {
  const env = options.env ?? process.env;
  const docker = options.docker ?? "docker";
  const container = options.forceSql
    ? undefined
    : postgresContainer(env, docker);
  const dumped = container ? pgDump(docker, container) : undefined;
  if (dumped !== undefined) return { method: "pg_dump", text: dumped };
  return { method: "sql", text: await sqlDump(env) };
}
