import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiUrlProblem,
  appendChangelog,
  changelogEntry,
  changelogProblem,
  computeIntegrity,
  decideRelease,
  fetchVersionInfo,
  inspectTarball,
  isRealRegistry,
  loadRelease,
  markPublished,
  PACKAGE_NAME,
  type Packed,
  packWidget,
  parseArgs,
  publishTarball,
  type Registry,
  type ReleaseManifest,
  registriesFor,
  resolveTokens,
  retryCommand,
  sameContent,
  saveRelease,
  sizeReport,
  tagName,
  verifyManifest,
} from "./release/lib";

const root = join(import.meta.dir, "..");
const widgetDir = join(root, "modules", "widget");
const options = parseArgs(process.argv.slice(2));
const selected = registriesFor(options);
const everyRegistry = registriesFor({ ...options, only: undefined });
const apiUrl = options.apiUrl ?? process.env.SUPPORT_API_URL;
const realTarget = everyRegistry.some((registry) =>
  isRealRegistry(registry.url),
);
const retry = options.only !== undefined;

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function fail(message: string): never {
  console.error(`[release] FAIL ${message}`);
  process.exit(1);
}

const version = (
  JSON.parse(readFileSync(join(widgetDir, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const tag = tagName(version);
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

if (options.writeChangelog) {
  const existing = existsSync(changelogPath)
    ? readFileSync(changelogPath, "utf8")
    : "";
  writeFileSync(changelogPath, appendChangelog(existing, entry));
  console.log(
    `[release] wrote the ${version} changelog entry; edit and commit modules/widget/CHANGELOG.md, nothing was published`,
  );
  process.exit(0);
}

const changelogMissing = changelogProblem(
  version,
  existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : undefined,
);

const mode = options.publish ? "publish" : "dry-run";
console.log(
  `[release] mode ${mode}${retry ? ", retry from the saved tarball" : ""}`,
);

if (changelogMissing && !options.publish) {
  console.log(`[release] FAIL ${changelogMissing}`);
}

if (options.publish) {
  const problems: string[] = [];
  if (changelogMissing && !retry) problems.push(changelogMissing);
  if (!retry) {
    const apiProblem = apiUrlProblem(apiUrl, realTarget);
    if (apiProblem) problems.push(apiProblem);
  }
  const { missing } = resolveTokens(selected, process.env);
  problems.push(...missing.map((line) => `missing token ${line}`));
  const tagExists = git(["tag", "--list", tag]) !== "";
  if (tagExists && !retry && !options.allowExisting) {
    problems.push(
      `tag ${tag} exists; bump the version or pass --allow-existing`,
    );
  }
  if (problems.length > 0) {
    console.error(
      "[release] FAIL preflight found missing items, nothing was sent:",
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}
console.log(`[release] version ${version}, tag ${tag}`);

let packed: Packed;
let manifest: ReleaseManifest | undefined;
if (retry) {
  manifest = loadRelease(root, version);
  if (!manifest) {
    fail(
      `no verified release manifest for ${version} under .release; run the full release first`,
    );
  }
  packed = inspectTarball(
    manifest.tarball,
    mkdtempSync(join(tmpdir(), "pw-release-retry-")),
  );
  console.log(`[release] reusing ${manifest.tarball} (${manifest.integrity})`);
} else {
  console.log("[release] build");
  const build = spawnSync("bun", ["run", "--filter", PACKAGE_NAME, "build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...(apiUrl ? { SUPPORT_API_URL: apiUrl } : {}) },
  });
  if (build.status !== 0) fail("widget build failed");
  packed = packWidget(widgetDir);
}

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
const local = computeIntegrity(packed.tarball);
console.log(`[release] tarball ${packed.tarball}`);
console.log(`[release] integrity ${local.integrity}`);

if (!options.publish) {
  console.log("[release] publish plan");
  for (const registry of selected) {
    const plan = publishTarball({ packed, registry, token: "", dryRun: true });
    console.log(
      `[release] ${registry.label} ${registry.url} ${PACKAGE_NAME}@${version} access public`,
    );
    for (const line of plan.output.trim().split("\n")) {
      console.log(`[release]   ${line}`);
    }
  }
  console.log(
    changelogMissing
      ? "[release] DRY RUN found a problem; nothing was sent"
      : "[release] DRY RUN complete; nothing was sent",
  );
  process.exit(changelogMissing ? 1 : 0);
}

const { tokens } = resolveTokens(everyRegistry, process.env);
const infos = await Promise.all(
  everyRegistry.map(async (registry) => ({
    registry,
    info: await fetchVersionInfo({
      registry,
      token: tokens.get(registry.id) ?? "",
      version,
    }),
  })),
);
const decision = decideRelease({
  version,
  local,
  infos,
  published: manifest?.published,
});
if (decision.action === "abort") {
  console.error("[release] FAIL registry check, nothing was sent:");
  for (const reason of decision.reasons) console.error(`  - ${reason}`);
  process.exit(1);
}

const done = (Object.entries(decision.registries) as [Registry["id"], string][])
  .filter(([, action]) => action === "done")
  .map(([id]) => id);
manifest = manifest
  ? manifest
  : saveRelease({ root, packed, version, integrity: local, published: done });
for (const id of done) manifest = markPublished(root, manifest, id);
console.log(
  `[release] manifest ${join(".release", `manifest-${version}.json`)}`,
);

const results: string[] = [];
for (const registry of selected) {
  if (decision.registries[registry.id] === "done") {
    results.push(`${registry.label} already holds the identical tarball`);
    console.log(
      `[release] PASS ${registry.label} already holds the identical tarball`,
    );
    continue;
  }
  const result = publishTarball({
    packed,
    registry,
    token: tokens.get(registry.id) as string,
  });
  let ok = result.outcome === "published";
  if (result.outcome === "already-published") {
    const now = await fetchVersionInfo({
      registry,
      token: tokens.get(registry.id) as string,
      version,
    });
    ok = sameContent(local, now);
  }
  if (!ok) {
    console.error(result.output);
    console.error(
      `[release] FAIL publish to ${registry.label}. Published so far: ${results.join(", ") || "none"}.`,
    );
    console.error(
      `[release] retry with the same tarball: ${retryCommand(registry)}`,
    );
    process.exit(1);
  }
  manifest = markPublished(root, manifest as ReleaseManifest, registry.id);
  results.push(`${registry.label} published`);
  console.log(`[release] PASS ${registry.label} published`);
}

console.log(`[release] next: git tag ${tag}`);
console.log(`[release] then:  git push origin ${tag}`);
