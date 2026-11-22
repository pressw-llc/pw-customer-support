import {
  closeDb,
  createDb,
  migrate,
  setProjectLinearTeam,
} from "@pw-support/db";

const clientSlug = process.env.SEED_CLIENT_SLUG || "acme";
const projectSlug = process.env.SEED_PROJECT_SLUG || "portal";
const teamId = process.argv[2] || process.env.SEED_LINEAR_TEAM_ID;

if (!teamId) {
  console.error(
    "[seed:settings] pass the Linear team id: bun run seed:settings <teamId>",
  );
  process.exit(1);
}

await migrate();
const db = createDb();
const updated = await setProjectLinearTeam(db, {
  clientSlug,
  projectSlug,
  linearTeamId: teamId,
});
await closeDb(db);

if (!updated) {
  console.error(
    `[seed:settings] project ${clientSlug}/${projectSlug} not found; run bun run seed:dev first`,
  );
  process.exit(1);
}
console.log(
  `[seed:settings] ${clientSlug}/${projectSlug} routes to team ${teamId}`,
);
