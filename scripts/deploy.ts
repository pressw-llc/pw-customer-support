import { join } from "node:path";

const root = join(import.meta.dir, "..");

if (process.env.CI) {
  console.log("[deploy] install dependencies");
  const install = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await install.exited) !== 0) process.exit(1);
}

await import("./deploy/main");
