import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export const PACKAGE_NAME = "@pressw-llc/support-react";
export const SIZE_BUDGET_BYTES = 2 * 1024 * 1024;

export interface Registry {
  id: "npm" | "github";
  label: string;
  url: string;
  tokenEnv: string[];
}

export const REGISTRIES: Registry[] = [
  {
    id: "npm",
    label: "npmjs",
    url: "https://registry.npmjs.org",
    tokenEnv: ["NPM_TOKEN"],
  },
  {
    id: "github",
    label: "GitHub Packages",
    url: "https://npm.pkg.github.com",
    tokenEnv: ["GITHUB_TOKEN", "GH_PACKAGES_TOKEN"],
  },
];

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Options {
  publish: boolean;
  allowExisting: boolean;
  writeChangelog: boolean;
  only: Registry["id"] | undefined;
  npmRegistry: string;
  ghRegistry: string;
  apiUrl: string | undefined;
}

export function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    if (at < 0) return undefined;
    const next = argv[at + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return next;
  };
  const only = value("--only");
  if (only !== undefined && only !== "npm" && only !== "github") {
    throw new Error("--only takes npm or github");
  }
  if (argv.includes("--dry-run") && argv.includes("--publish")) {
    throw new Error("--dry-run and --publish conflict");
  }
  return {
    publish: argv.includes("--publish"),
    allowExisting: argv.includes("--allow-existing"),
    writeChangelog: argv.includes("--write-changelog"),
    only,
    npmRegistry: value("--npm-registry") ?? REGISTRIES[0].url,
    ghRegistry: value("--gh-registry") ?? REGISTRIES[1].url,
    apiUrl: value("--api-url"),
  };
}

export function registriesFor(options: Options): Registry[] {
  return REGISTRIES.filter(
    (registry) => options.only === undefined || registry.id === options.only,
  ).map((registry) => ({
    ...registry,
    url: registry.id === "npm" ? options.npmRegistry : options.ghRegistry,
  }));
}

export function isRealRegistry(url: string): boolean {
  return REGISTRIES.some((registry) => registry.url === url);
}

export function resolveTokens(
  registries: Registry[],
  env: Record<string, string | undefined>,
): { tokens: Map<string, string>; missing: string[] } {
  const tokens = new Map<string, string>();
  const missing: string[] = [];
  for (const registry of registries) {
    const name = registry.tokenEnv.find((key) => env[key]);
    if (name) tokens.set(registry.id, env[name] as string);
    else missing.push(`${registry.label}: ${registry.tokenEnv.join(" or ")}`);
  }
  return { tokens, missing };
}

export function apiUrlProblem(
  apiUrl: string | undefined,
  realTarget: boolean,
): string | undefined {
  if (!realTarget) return undefined;
  if (!apiUrl) return "set --api-url or SUPPORT_API_URL to the production API";
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return `the API URL "${apiUrl}" is not a URL`;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" || local) {
    return `the API URL "${apiUrl}" must be a public https URL for a real publish`;
  }
  return undefined;
}

export function tagName(version: string): string {
  return `support-react-v${version}`;
}

export function collectExportTargets(exports: unknown): string[] {
  if (typeof exports === "string") return [exports];
  if (exports && typeof exports === "object") {
    return Object.values(exports).flatMap(collectExportTargets);
  }
  return [];
}

export type Manifest = Record<string, unknown> & {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  repository?: unknown;
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  publishConfig?: { access?: string; registry?: string };
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
};

const REQUIRED_FILES = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/support-widget.global.js",
];

const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(1)} kB`;
}

export function verifyManifest(
  pkg: Manifest,
  entries: { path: string; size: number }[],
): Check[] {
  const present = new Set(entries.map((entry) => entry.path));
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) =>
    checks.push({ name, ok, detail });

  add(
    "name",
    pkg.name === PACKAGE_NAME,
    `${pkg.name ?? "missing"} (want ${PACKAGE_NAME})`,
  );
  add(
    "version",
    typeof pkg.version === "string" &&
      /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version),
    String(pkg.version),
  );
  add("not private", pkg.private !== true, `private=${pkg.private}`);
  add("access public", pkg.publishConfig?.access === "public", "publishConfig");
  add(
    "no pinned registry",
    pkg.publishConfig?.registry === undefined,
    "the registry comes from the release script",
  );
  add("license field", Boolean(pkg.license), String(pkg.license));
  add("repository field", Boolean(pkg.repository), "repository");

  for (const file of REQUIRED_FILES) {
    add(`ships ${file}`, present.has(file), "tarball");
  }
  add("ships README.md", present.has("README.md"), "tarball");
  add(
    "ships a license file",
    [...present].some((path) => /^LICENSE(\..+)?$/.test(path)),
    "tarball",
  );

  const targets = [
    ...collectExportTargets(pkg.exports),
    ...[pkg.main, pkg.module, pkg.types].filter(
      (value): value is string => typeof value === "string",
    ),
  ];
  const missing = targets.filter(
    (target) => !present.has(target.replace(/^\.\//, "")),
  );
  add(
    "exports resolve",
    targets.length > 0 && missing.length === 0,
    missing.length
      ? `missing ${missing.join(", ")}`
      : `${targets.length} paths`,
  );

  const leaks = DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(pkg[field] ?? {})
      .filter(
        ([name, range]) =>
          name.startsWith("@pw-support/") ||
          String(range).startsWith("workspace:"),
      )
      .map(([name]) => `${field}:${name}`),
  );
  add(
    "no private dependency leaks",
    leaks.length === 0,
    leaks.length ? leaks.join(", ") : "none",
  );
  add(
    "no dev metadata",
    pkg.devDependencies === undefined && pkg.scripts === undefined,
    "devDependencies and scripts stripped",
  );

  const allowed = new Set(["dist", "README.md", "LICENSE", "CHANGELOG.md"]);
  const stray = [...present].filter(
    (path) =>
      path !== "package.json" && !allowed.has(path.split("/")[0] as string),
  );
  add(
    "files whitelist",
    stray.length === 0,
    stray.length ? `stray ${stray.join(", ")}` : "dist and docs only",
  );

  const bundle = entries.find(
    (entry) => entry.path === "dist/support-widget.global.js",
  );
  add(
    "bundle size",
    bundle !== undefined && bundle.size <= SIZE_BUDGET_BYTES,
    bundle ? formatSize(bundle.size) : "missing",
  );
  return checks;
}

export function sizeReport(
  tarballBytes: number,
  entries: { path: string; size: number }[],
): string[] {
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const largest = [...entries].sort((a, b) => b.size - a.size).slice(0, 5);
  return [
    `tarball ${formatSize(tarballBytes)}, unpacked ${formatSize(total)}, ${entries.length} files`,
    ...largest.map(
      (entry) => `  ${entry.path.padEnd(36)} ${formatSize(entry.size)}`,
    ),
  ];
}

export function stageManifest(pkg: Manifest): Manifest {
  const { devDependencies: _d, scripts: _s, ...rest } = pkg;
  const publishConfig = { ...(rest.publishConfig ?? {}) };
  delete publishConfig.registry;
  return { ...rest, publishConfig };
}

export function npmrcFor(registries: { url: string; token: string }[]): string {
  return `${registries
    .map(
      (registry) =>
        `//${registry.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}/:_authToken=${registry.token}`,
    )
    .join("\n")}\n`;
}

export function isAlreadyPublished(output: string): boolean {
  return /cannot publish over|previously published|already (exists|present|published)|e409|409 conflict/i.test(
    output,
  );
}

export function changelogEntry(
  version: string,
  date: string,
  subjects: string[],
): string {
  const lines = subjects.length ? subjects : ["Release build."];
  return `## ${version} - ${date}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`;
}

export function changelogHeaderFor(version: string, date: string): string {
  return `## ${version} - ${date}`;
}

export function changelogProblem(
  version: string,
  text: string | undefined,
  date = new Date().toISOString().slice(0, 10),
): string | undefined {
  const present = (text ?? "")
    .split("\n")
    .some(
      (line) => line === `## ${version}` || line.startsWith(`## ${version} - `),
    );
  return present
    ? undefined
    : `modules/widget/CHANGELOG.md has no entry for ${version}; add the header "${changelogHeaderFor(version, date)}" with its notes, or run bun run release --write-changelog, then commit it`;
}

export function appendChangelog(existing: string, entry: string): string {
  const heading = (entry.split("\n")[0] as string).split(" - ")[0] as string;
  if (existing.split("\n").some((line) => line.startsWith(`${heading} - `))) {
    return existing;
  }
  const body = existing.replace(/^# Changelog\n+/, "");
  return `# Changelog\n\n${entry}\n${body}`.trimEnd().concat("\n");
}

export function dirtyProblem(status: string): string | undefined {
  const lines = status.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0
    ? undefined
    : `modules/widget has uncommitted changes (${lines.length}); commit or stash them so the tarball matches a commit`;
}

export interface ReleaseProblemInput {
  retry: boolean;
  version: string;
  apiUrl: string | undefined;
  realTarget: boolean;
  allowExisting: boolean;
  tagExists: boolean;
  tag: string;
  changelog: string | undefined;
  dirtyStatus: string;
  missingTokens: string[];
}

export function releaseProblems(input: ReleaseProblemInput): {
  blocking: string[];
  tokens: string[];
} {
  const blocking: string[] = [];
  if (!input.retry) {
    if (input.changelog) blocking.push(input.changelog);
    const apiProblem = apiUrlProblem(input.apiUrl, input.realTarget);
    if (apiProblem) blocking.push(apiProblem);
    const dirty = dirtyProblem(input.dirtyStatus);
    if (dirty) blocking.push(dirty);
    if (input.tagExists && !input.allowExisting) {
      blocking.push(
        `tag ${input.tag} exists; bump the version or pass --allow-existing`,
      );
    }
  }
  return {
    blocking,
    tokens: input.missingTokens.map((line) => `missing token ${line}`),
  };
}

export function retryCommand(registry: Registry): string {
  return `bun run release --publish --only ${registry.id}`;
}

export function listFiles(dir: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ path: relative(dir, full), size: statSync(full).size });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface Packed {
  tarball: string;
  tarballBytes: number;
  entries: { path: string; size: number }[];
  manifest: Manifest;
  workDir: string;
}

export function packWidget(widgetDir: string): Packed {
  const workDir = mkdtempSync(join(tmpdir(), "pw-release-"));
  const stage = join(workDir, "stage");
  mkdirSync(stage);
  cpSync(join(widgetDir, "dist"), join(stage, "dist"), { recursive: true });
  for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    if (existsSync(join(widgetDir, file))) {
      cpSync(join(widgetDir, file), join(stage, file));
    }
  }
  const pkg = JSON.parse(
    readFileSync(join(widgetDir, "package.json"), "utf8"),
  ) as Manifest;
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(stageManifest(pkg), null, 2)}\n`,
  );
  normalizeMtimes(stage);
  const out = join(workDir, "out");
  mkdirSync(out);
  const packed = spawnSync(
    "bun",
    ["pm", "pack", "--destination", out, "--quiet"],
    { cwd: stage, encoding: "utf8" },
  );
  if (packed.status !== 0) {
    throw new Error(`bun pm pack failed: ${packed.stderr || packed.stdout}`);
  }
  const tarball = join(
    out,
    readdirSync(out).find((name) => name.endsWith(".tgz")) as string,
  );
  return inspectTarball(tarball, workDir);
}

export const FIXED_MTIME = new Date("2020-01-01T00:00:00Z");

export function normalizeMtimes(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) normalizeMtimes(full);
    utimesSync(full, FIXED_MTIME, FIXED_MTIME);
  }
  utimesSync(dir, FIXED_MTIME, FIXED_MTIME);
}

export function inspectTarball(tarball: string, workDir: string): Packed {
  const fixed = join(workDir, "extract");
  const extract = existsSync(fixed)
    ? mkdtempSync(join(workDir, "extract-"))
    : (mkdirSync(fixed), fixed);
  const untar = spawnSync("tar", ["-xzf", tarball, "-C", extract], {
    encoding: "utf8",
  });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
  const root = join(extract, "package");
  return {
    tarball,
    tarballBytes: statSync(tarball).size,
    entries: listFiles(root),
    manifest: JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as Manifest,
    workDir,
  };
}

export interface Integrity {
  integrity: string;
  shasum: string;
}

export function computeIntegrity(tarball: string): Integrity {
  const bytes = readFileSync(tarball);
  return {
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

export type VersionInfo =
  | { state: "absent" }
  | { state: "present"; integrity?: string; shasum?: string }
  | { state: "error"; message: string };

export async function fetchVersionInfo(input: {
  registry: Registry;
  token: string;
  version: string;
  fetcher?: typeof fetch;
}): Promise<VersionInfo> {
  const fetcher = input.fetcher ?? fetch;
  const url = `${input.registry.url.replace(/\/$/, "")}/${PACKAGE_NAME.replace("/", "%2f")}`;
  try {
    const response = await fetcher(url, {
      headers: input.token ? { authorization: `Bearer ${input.token}` } : {},
    });
    if (response.status === 404) return { state: "absent" };
    if (response.status === 401 || response.status === 403) {
      return {
        state: "error",
        message: `${input.registry.label} refused the token (${response.status})`,
      };
    }
    if (!response.ok) {
      return {
        state: "error",
        message: `${input.registry.label} answered ${response.status}`,
      };
    }
    const body = (await response.json()) as {
      versions?: Record<
        string,
        { dist?: { integrity?: string; shasum?: string } }
      >;
    };
    const dist = body.versions?.[input.version]?.dist;
    return dist
      ? { state: "present", integrity: dist.integrity, shasum: dist.shasum }
      : { state: "absent" };
  } catch (error) {
    return {
      state: "error",
      message: `${input.registry.label} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function sameContent(local: Integrity, remote: VersionInfo): boolean {
  if (remote.state !== "present") return false;
  if (remote.integrity) return remote.integrity === local.integrity;
  return remote.shasum === local.shasum;
}

export type RegistryAction = "publish" | "done";

export type ReleaseDecision =
  | { action: "go"; registries: Record<string, RegistryAction> }
  | { action: "abort"; reasons: string[] };

export function decideRelease(input: {
  version: string;
  local: Integrity;
  infos: { registry: Registry; info: VersionInfo }[];
  published?: Registry["id"][];
}): ReleaseDecision {
  const reasons: string[] = [];
  const registries: Record<string, RegistryAction> = {};
  for (const { registry, info } of input.infos) {
    if (info.state === "error") {
      reasons.push(info.message);
    } else if (info.state === "present") {
      if (sameContent(input.local, info)) registries[registry.id] = "done";
      else {
        reasons.push(
          `${registry.label} already holds ${input.version} with different content; bump the version`,
        );
      }
    } else {
      if (input.published?.includes(registry.id)) {
        reasons.push(
          `${registry.label} no longer holds the tarball the release manifest recorded`,
        );
      }
      registries[registry.id] = "publish";
    }
  }
  return reasons.length > 0
    ? { action: "abort", reasons }
    : { action: "go", registries };
}

export interface ReleaseManifest {
  version: string;
  tarball: string;
  integrity: string;
  shasum: string;
  published: Registry["id"][];
}

export const RELEASE_DIR = ".release";

export function manifestPath(root: string, version: string): string {
  return join(root, RELEASE_DIR, `manifest-${version}.json`);
}

export function saveRelease(input: {
  root: string;
  packed: Packed;
  version: string;
  integrity: Integrity;
  published: Registry["id"][];
}): ReleaseManifest {
  const dir = join(input.root, RELEASE_DIR);
  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, `support-react-${input.version}.tgz`);
  cpSync(input.packed.tarball, tarball);
  const manifest: ReleaseManifest = {
    version: input.version,
    tarball,
    integrity: input.integrity.integrity,
    shasum: input.integrity.shasum,
    published: input.published,
  };
  writeFileSync(
    manifestPath(input.root, input.version),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export function loadRelease(
  root: string,
  version: string,
): ReleaseManifest | undefined {
  const path = manifestPath(root, version);
  if (!existsSync(path)) return undefined;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as ReleaseManifest;
  if (!existsSync(manifest.tarball)) return undefined;
  const actual = computeIntegrity(manifest.tarball);
  return actual.integrity === manifest.integrity ? manifest : undefined;
}

export function markPublished(
  root: string,
  manifest: ReleaseManifest,
  id: Registry["id"],
): ReleaseManifest {
  const next = {
    ...manifest,
    published: [...new Set([...manifest.published, id])],
  };
  writeFileSync(
    manifestPath(root, manifest.version),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
}

export type Runner = (
  command: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => { status: number; output: string };

export const spawnRunner: Runner = (command, options) => {
  const result = spawnSync(command[0] as string, command.slice(1), {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

export type PublishOutcome = "published" | "already-published" | "failed";

export function publishTarball(input: {
  packed: Packed;
  registry: Registry;
  token: string;
  run?: Runner;
  dryRun?: boolean;
}): { outcome: PublishOutcome; output: string } {
  const cwd = join(input.packed.workDir, `publish-${input.registry.id}`);
  mkdirSync(cwd, { recursive: true });
  const npmrc = join(cwd, ".npmrc");
  writeFileSync(
    join(cwd, "package.json"),
    `${JSON.stringify(input.packed.manifest)}\n`,
  );
  writeFileSync(
    npmrc,
    input.token
      ? `registry=${input.registry.url.replace(/\/$/, "")}/\n${npmrcFor([{ url: input.registry.url, token: input.token }])}`
      : "",
    { mode: 0o600 },
  );
  const run = input.run ?? spawnRunner;
  const result = run(
    [
      "bun",
      "publish",
      input.packed.tarball,
      "--registry",
      input.registry.url,
      "--access",
      "public",
      "--tag",
      "latest",
      ...(input.dryRun ? ["--dry-run"] : []),
    ],
    { cwd, env: { ...process.env } },
  );
  rmSync(cwd, { recursive: true, force: true });
  const output = input.token
    ? result.output.split(input.token).join("***")
    : result.output;
  if (result.status === 0) return { outcome: "published", output };
  return {
    outcome: isAlreadyPublished(output) ? "already-published" : "failed",
    output,
  };
}
