import { adminDevEnv } from "./dev-admin-env";

const proc = Bun.spawn(["bunx", "vite"], {
  cwd: "modules/admin",
  env: adminDevEnv(),
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});
process.exit(await proc.exited);
