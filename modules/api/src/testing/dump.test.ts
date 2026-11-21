import { expect, test } from "bun:test";
import { dumpDatabase } from "./dump";

test("dumps every table through SQL when asked", async () => {
  const dump = await dumpDatabase({ forceSql: true });
  expect(dump.method).toBe("sql");
  expect(dump.text).toContain("0006_admin_settings.sql");
});

test("falls back to SQL when the docker binary is missing", async () => {
  const dump = await dumpDatabase({ docker: "docker-binary-not-installed" });
  expect(dump.method).toBe("sql");
});

test("prefers pg_dump when the Postgres container is reachable", async () => {
  const dump = await dumpDatabase();
  expect(["pg_dump", "sql"]).toContain(dump.method);
  expect(dump.text).toContain("support");
});
