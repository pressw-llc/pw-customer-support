import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiUrlProblem,
  appendChangelog,
  changelogEntry,
  isRealRegistry,
  PACKAGE_NAME,
  packWidget,
  parseArgs,
  publishTarball,
  registriesFor,
  resolveTokens,
  retryCommand,
  sizeReport,
  tagName,
  verifyManifest,
} from "./release/lib";

const root = join(import.meta.dir, "..");
const widgetDir = join(root, "modules", "widget");
const options = parseArgs(process.argv.slice(2));
const registries = registriesFor(options);
const apiUrl = options.apiUrl ?? process.env.SUPPORT_API_URL;
const realTarget = registries.some((registry) => isRealRegistry(registry.url));

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function fail(message: string): never {
  console.error(`[release] FAIL ${message}`);
  process.exit(1);
}

const mode = options.publish ? "publish" : "dry-run";
console.log(`[release] mode ${mode}`);

if (options.publish) {
  const problem = apiUrlProblem(apiUrl, realTarget);
  if (problem) fail(problem);
  const { missing } = resolveTokens(registries, process.env);
  if (missing.length > 0) {
    fail(`missing tokens before anything is sent: ${missing.join("; ")}`);
  }
}

const version = (
  JSON.parse(readFileSync(join(widgetDir, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const tag = tagName(version);
const tagExists = git(["tag", "--list", tag]) !== "";
if (tagExists && options.publish && !options.allowExisting) {
  fail(`tag ${tag} exists; bump the version or pass --allow-existing`);
}
console.log(
  `[release] version ${version}, tag ${tag} ${tagExists ? "exists" : "is free"}`,
);

console.log("[release] build");
const build = spawnSync("bun", ["run", "--filter", PACKAGE_NAME, "build"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...(apiUrl ? { SUPPORT_API_URL: apiUrl } : {}) },
});
if (build.status !== 0) fail("widget build failed");

const packed = packWidget(widgetDir);
const checks = verifyManifest(packed.manifest, packed.entries);
for (const check of checks) {
  console.log(
    `[release] ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
  );
}
for (const line of sizeReport(packed.tarballBytes, packed.entries)) {
  console.log(`[release] ${line}`);
}
if (checks.some((check) => !check.ok)) fail("package verification failed");
if (packed.manifest.version !== version) fail("tarball version mismatch");
console.log(`[release] tarball ${packed.tarball}`);

const lastTag = git([
  "tag",
  "--list",
  "support-react-v*",
  "--sort=-v:refname",
]).split("\n")[0];
const subjects = git([
  "log",
  "--pretty=%s",
  ...(lastTag ? [`${lastTag}..HEAD`] : []),
  "--",
  "modules/widget",
])
  .split("\n")
  .filter(Boolean)
  .slice(0, 20);
const entry = changelogEntry(
  version,
  new Date().toISOString().slice(0, 10),
  subjects,
);
const changelogPath = join(widgetDir, "CHANGELOG.md");

if (!options.publish) {
  console.log("[release] publish plan");
  for (const registry of registries) {
    const plan = publishTarball({
      packed,
      registry,
      token: "",
      dryRun: true,
    });
    console.log(
      `[release] ${registry.label} ${registry.url} ${PACKAGE_NAME}@${version} access public`,
    );
    for (const line of plan.output.trim().split("\n")) {
      console.log(`[release]   ${line}`);
    }
  }
  console.log("[release] changelog entry that --publish appends");
  console.log(entry);
  console.log("[release] DRY RUN complete; nothing was sent");
  process.exit(0);
}

const { tokens } = resolveTokens(registries, process.env);
const results: string[] = [];
for (const registry of registries) {
  const result = publishTarball({
    packed,
    registry,
    token: tokens.get(registry.id) as string,
  });
  if (result.outcome === "failed") {
    console.error(result.output);
    console.error(
      `[release] FAIL publish to ${registry.label}. Published so far: ${results.join(", ") || "none"}.`,
    );
    console.error(`[release] retry: ${retryCommand(registry)}`);
    process.exit(1);
  }
  results.push(`${registry.label} ${result.outcome}`);
  console.log(`[release] PASS ${registry.label} ${result.outcome}`);
}

if (options.changelog) {
  const existing = existsSync(changelogPath)
    ? readFileSync(changelogPath, "utf8")
    : "";
  writeFileSync(changelogPath, appendChangelog(existing, entry));
  console.log(
    "[release] changelog updated; commit modules/widget/CHANGELOG.md",
  );
}
console.log(`[release] next: git tag ${tag}`);
console.log(`[release] then:  git push origin ${tag}`);
