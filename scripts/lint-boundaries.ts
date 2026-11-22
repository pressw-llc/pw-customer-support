import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface Violation {
  file: string;
  line: number;
  specifier: string;
  reason: string;
}

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    if (entry.name === "dist" || entry.name === "coverage") return [];
    if (entry.name === "fixtures") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

interface WorkspaceModule {
  dir: string;
  allowed: Set<string>;
}

function declaredSpecifiers(name: string, exportsField: unknown): Set<string> {
  const allowed = new Set([name]);
  if (typeof exportsField !== "object" || exportsField === null) {
    return allowed;
  }
  for (const key of Object.keys(exportsField)) {
    if (!key.startsWith("./") || key.startsWith("./src")) continue;
    allowed.add(`${name}/${key.slice(2)}`);
  }
  return allowed;
}

function workspaceModules(root: string): Map<string, WorkspaceModule> {
  const modulesDir = join(root, "modules");
  const byPackage = new Map<string, WorkspaceModule>();
  if (!existsSync(modulesDir)) return byPackage;
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    const manifest = join(modulesDir, entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      name: string;
      exports?: unknown;
    };
    byPackage.set(parsed.name, {
      dir: resolve(modulesDir, entry.name),
      allowed: declaredSpecifiers(parsed.name, parsed.exports),
    });
  }
  return byPackage;
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

function moduleDirOf(path: string, moduleDirs: string[]): string | undefined {
  return moduleDirs.find((dir) => path === dir || path.startsWith(dir + sep));
}

export function findViolations(root: string): Violation[] {
  const absoluteRoot = resolve(root);
  const packages = workspaceModules(absoluteRoot);
  const moduleDirs = [...packages.values()].map((entry) => entry.dir);
  const violations: Violation[] = [];

  for (const file of sourceFiles(absoluteRoot)) {
    const ownModule = moduleDirOf(file, moduleDirs);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[2] as string;
      const line = text.slice(0, match.index).split("\n").length;
      const report = (reason: string) =>
        violations.push({ file, line, specifier, reason });

      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        const targetModule = moduleDirOf(target, moduleDirs);
        if (targetModule && targetModule !== ownModule) {
          report("relative import reaches into another module");
        }
        continue;
      }

      const name = packageNameOf(specifier);
      const target = packages.get(name);
      if (
        target &&
        !target.allowed.has(specifier) &&
        target.dir !== ownModule
      ) {
        report(
          "deep import into another module; use its package entrypoint or a declared exports subpath",
        );
      }
    }
  }
  return violations;
}

function rootFromArgs(args: string[]): string {
  const index = args.indexOf("--root");
  return index >= 0 && args[index + 1] ? (args[index + 1] as string) : ".";
}

export function main(args: string[]): number {
  const violations = findViolations(rootFromArgs(args));
  for (const v of violations) {
    console.error(`${v.file}:${v.line} "${v.specifier}" ${v.reason}`);
  }
  if (violations.length > 0) {
    console.error(`[lint-boundaries] ${violations.length} violation(s)`);
    return 1;
  }
  console.log("[lint-boundaries] no violations");
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
