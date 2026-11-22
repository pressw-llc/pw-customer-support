import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { buildPluginBundle } from "./plugin-bundle";

const { outDir, cliBytes } = await buildPluginBundle();
console.log(
  `[build:plugin] ${outDir} (lib/cli.js ${(cliBytes / 1024).toFixed(0)} kB)`,
);

if (process.argv.includes("--no-validate")) process.exit(0);

const validated = spawnSync("claude", ["plugin", "validate", outDir], {
  encoding: "utf8",
});
process.stdout.write(validated.stdout ?? "");
process.stderr.write(validated.stderr ?? "");
if (validated.error) {
  console.error(
    "[build:plugin] claude CLI not found; install it or pass --no-validate",
  );
  process.exit(1);
}
if (validated.status !== 0) process.exit(validated.status ?? 1);
console.log(`[build:plugin] claude plugin validate passed for ${join(outDir)}`);
