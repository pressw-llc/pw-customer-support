import { rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const apiUrl = process.env.SUPPORT_API_URL ?? "http://localhost:8787";
const define = { __SUPPORT_API_URL__: JSON.stringify(apiUrl) };

function assertBuilt(result: Awaited<ReturnType<typeof Bun.build>>) {
  if (result.success) return;
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });

assertBuilt(
  await Bun.build({
    entrypoints: [join(root, "src/index.ts")],
    outdir: dist,
    format: "esm",
    target: "browser",
    external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
    define,
  }),
);

assertBuilt(
  await Bun.build({
    entrypoints: [join(root, "src/global.ts")],
    outdir: dist,
    naming: "support-widget.global.js",
    format: "iife",
    target: "browser",
    minify: true,
    define: { ...define, "process.env.NODE_ENV": '"production"' },
  }),
);

const types = Bun.spawnSync(
  ["bunx", "tsc", "-p", join(root, "tsconfig.build.json")],
  { stdout: "inherit", stderr: "inherit", cwd: root },
);
if (types.exitCode !== 0) process.exit(types.exitCode ?? 1);

console.log(`[widget:build] dist ready, default api url ${apiUrl}`);
