import { closeDb, createDb, ensureProject, migrate } from "@pw-support/db";

const clientSlug = process.env.SEED_CLIENT_SLUG || "acme";
const projectSlug = process.env.SEED_PROJECT_SLUG || "portal";

await migrate();
const db = createDb();
const { key } = await ensureProject(db, {
  clientSlug,
  projectSlug,
  name: `${clientSlug} ${projectSlug}`,
  key: process.env.SEED_PROJECT_KEY || undefined,
});
await closeDb(db);

console.log(`[seed:dev] project ${clientSlug}/${projectSlug}`);
console.log(`[seed:dev] project key ${key}`);
