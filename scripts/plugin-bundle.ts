import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pluginDir = join(root, "modules", "plugin");

export const DEFAULT_PLUGIN_OUT = join(pluginDir, "dist", "plugin");

const LAUNCHER = `#!/bin/sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bun "$ROOT/lib/cli.js" "$@"
`;

export interface BundleResult {
  outDir: string;
  cliBytes: number;
}

export async function buildPluginBundle(
  outDir: string = DEFAULT_PLUGIN_OUT,
): Promise<BundleResult> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "lib"), { recursive: true });
  mkdirSync(join(outDir, "bin"), { recursive: true });

  const built = await Bun.build({
    entrypoints: [join(pluginDir, "src", "cli.ts")],
    outdir: join(outDir, "lib"),
    target: "bun",
    format: "esm",
    naming: "cli.js",
    minify: false,
  });
  if (!built.success) {
    throw new Error(built.logs.join("\n"));
  }

  cpSync(join(pluginDir, ".claude-plugin"), join(outDir, ".claude-plugin"), {
    recursive: true,
  });
  cpSync(join(pluginDir, ".mcp.json"), join(outDir, ".mcp.json"));
  cpSync(join(pluginDir, "README.md"), join(outDir, "README.md"));
  cpSync(join(pluginDir, "commands"), join(outDir, "commands"), {
    recursive: true,
  });
  cpSync(join(pluginDir, "skills"), join(outDir, "skills"), {
    recursive: true,
  });
  const launcher = join(outDir, "bin", "pw-support");
  writeFileSync(launcher, LAUNCHER);
  chmodSync(launcher, 0o755);

  const cli = readFileSync(join(outDir, "lib", "cli.js"), "utf8");
  return { outDir, cliBytes: cli.length };
}

export function workspaceImportsIn(bundle: string): string[] {
  return [...bundle.matchAll(/from\s+["'](@pw-support\/[^"']+)["']/g)].map(
    (match) => match[1] as string,
  );
}
