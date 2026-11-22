import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiUrlProblem,
  appendChangelog,
  changelogEntry,
  collectExportTargets,
  computeIntegrity,
  decideRelease,
  fetchVersionInfo,
  formatSize,
  isAlreadyPublished,
  isRealRegistry,
  listFiles,
  loadRelease,
  markPublished,
  npmrcFor,
  type Packed,
  packWidget,
  parseArgs,
  publishTarball,
  REGISTRIES,
  type Registry,
  type Runner,
  registriesFor,
  resolveTokens,
  retryCommand,
  sameContent,
  saveRelease,
  sizeReport,
  stageManifest,
  tagName,
  verifyManifest,
} from "./lib";

const widgetDir = join(import.meta.dir, "..", "..", "modules", "widget");
const widgetManifest = JSON.parse(
  readFileSync(join(widgetDir, "package.json"), "utf8"),
);

const goodEntries = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/support-widget.global.js",
].map((path) => ({ path, size: 1000 }));

const goodManifest = stageManifest(widgetManifest);
const failing = (checks: { name: string; ok: boolean }[]) =>
  checks.filter((check) => !check.ok).map((check) => check.name);

describe("parseArgs", () => {
  test("defaults to a dry run on the real registries", () => {
    const options = parseArgs([]);
    expect(options.publish).toBe(false);
    expect(options.changelog).toBe(true);
    expect(options.npmRegistry).toBe("https://registry.npmjs.org");
    expect(options.ghRegistry).toBe("https://npm.pkg.github.com");
  });

  test("reads publish, overrides, and a single registry", () => {
    const options = parseArgs([
      "--publish",
      "--allow-existing",
      "--no-changelog",
      "--only",
      "github",
      "--npm-registry",
      "http://127.0.0.1:1",
      "--gh-registry",
      "http://127.0.0.1:2",
      "--api-url",
      "https://api.example.test",
    ]);
    expect(options).toMatchObject({
      publish: true,
      allowExisting: true,
      changelog: false,
      only: "github",
      apiUrl: "https://api.example.test",
    });
    expect(registriesFor(options).map((r) => r.url)).toEqual([
      "http://127.0.0.1:2",
    ]);
  });

  test("rejects bad input", () => {
    expect(() => parseArgs(["--only", "other"])).toThrow("npm or github");
    expect(() => parseArgs(["--dry-run", "--publish"])).toThrow("conflict");
    expect(() => parseArgs(["--api-url"])).toThrow("needs a value");
    expect(() => parseArgs(["--api-url", "--publish"])).toThrow(
      "needs a value",
    );
  });

  test("keeps both registries and flags real ones", () => {
    const registries = registriesFor(parseArgs([]));
    expect(registries.map((registry) => registry.id)).toEqual([
      "npm",
      "github",
    ]);
    expect(isRealRegistry(registries[0]?.url as string)).toBe(true);
    expect(isRealRegistry("http://127.0.0.1:4873")).toBe(false);
  });
});

describe("tokens and api url", () => {
  test("requires every selected registry token", () => {
    const none = resolveTokens(REGISTRIES, {});
    expect(none.missing).toHaveLength(2);
    const both = resolveTokens(REGISTRIES, {
      NPM_TOKEN: "a",
      GH_PACKAGES_TOKEN: "b",
    });
    expect(both.missing).toEqual([]);
    expect(both.tokens.get("github")).toBe("b");
    const one = resolveTokens(REGISTRIES.slice(1), { GITHUB_TOKEN: "c" });
    expect(one.tokens.get("github")).toBe("c");
  });

  test("refuses a local or non-https API URL for a real publish only", () => {
    expect(apiUrlProblem(undefined, false)).toBeUndefined();
    expect(apiUrlProblem("http://localhost:8787", false)).toBeUndefined();
    expect(apiUrlProblem(undefined, true)).toContain("--api-url");
    expect(apiUrlProblem("nope", true)).toContain("not a URL");
    expect(apiUrlProblem("http://localhost:8787", true)).toContain("https");
    expect(apiUrlProblem("https://127.0.0.1", true)).toContain("https");
    expect(apiUrlProblem("https://api.example.test", true)).toBeUndefined();
  });

  test("builds the tag name and an npmrc", () => {
    expect(tagName("1.2.3")).toBe("support-react-v1.2.3");
    expect(npmrcFor([{ url: "http://127.0.0.1:4873/", token: "t" }])).toBe(
      "//127.0.0.1:4873/:_authToken=t\n",
    );
    expect(retryCommand(REGISTRIES[1] as never)).toContain("--only github");
  });
});

describe("verifyManifest", () => {
  test("passes the real widget manifest against a complete tarball", () => {
    expect(failing(verifyManifest(goodManifest, goodEntries))).toEqual([]);
  });

  test("fails a private package, a pinned registry, and missing metadata", () => {
    const bad = {
      ...goodManifest,
      private: true,
      license: undefined,
      repository: undefined,
      publishConfig: { access: "restricted", registry: "https://x" },
    };
    expect(failing(verifyManifest(bad, goodEntries))).toEqual([
      "not private",
      "access public",
      "no pinned registry",
      "license field",
      "repository field",
    ]);
  });

  test("fails missing files and exports that point nowhere", () => {
    const entries = goodEntries.filter(
      (entry) => entry.path !== "dist/support-widget.global.js",
    );
    const names = failing(verifyManifest(goodManifest, entries));
    expect(names).toContain("ships dist/support-widget.global.js");
    expect(names).toContain("exports resolve");
    expect(names).toContain("bundle size");
    expect(
      failing(
        verifyManifest(
          {
            ...goodManifest,
            exports: undefined,
            main: undefined,
            module: undefined,
            types: undefined,
          },
          goodEntries,
        ),
      ),
    ).toContain("exports resolve");
  });

  test("fails workspace dependency leaks and dev metadata", () => {
    const names = failing(
      verifyManifest(
        {
          ...goodManifest,
          dependencies: { "@pw-support/contracts": "workspace:*" },
          peerDependencies: { other: "workspace:^" },
          devDependencies: {},
          scripts: {},
        },
        goodEntries,
      ),
    );
    expect(names).toContain("no private dependency leaks");
    expect(names).toContain("no dev metadata");
  });

  test("fails stray files, an oversize bundle, and a wrong name or version", () => {
    const names = failing(
      verifyManifest({ ...goodManifest, name: "x", version: "latest" }, [
        ...goodEntries.filter(
          (entry) =>
            !entry.path.startsWith("LICENSE") &&
            entry.path !== "dist/support-widget.global.js",
        ),
        { path: "src/secret.ts", size: 1 },
        { path: "dist/support-widget.global.js", size: 3 * 1024 * 1024 },
      ]),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "name",
        "version",
        "ships a license file",
        "files whitelist",
        "bundle size",
      ]),
    );
  });
});

describe("helpers", () => {
  test("collects nested export targets", () => {
    expect(
      collectExportTargets({
        ".": { types: "./a.d.ts", import: "./a.js" },
        "./g": "./g.js",
      }),
    ).toEqual(["./a.d.ts", "./a.js", "./g.js"]);
    expect(collectExportTargets(undefined)).toEqual([]);
  });

  test("formats sizes and the report", () => {
    expect(formatSize(2048)).toBe("2.0 kB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.00 MB");
    const report = sizeReport(1024, [
      { path: "a", size: 10 },
      { path: "b", size: 20 },
    ]);
    expect(report[0]).toContain("2 files");
    expect(report[1]).toContain("b");
  });

  test("detects an already published version", () => {
    expect(
      isAlreadyPublished(
        "error: cannot publish over the previously published versions",
      ),
    ).toBe(true);
    expect(isAlreadyPublished("E409 Conflict")).toBe(true);
    expect(isAlreadyPublished("connection refused")).toBe(false);
  });

  test("appends the changelog once per version", () => {
    const entry = changelogEntry("0.1.0", "2026-01-01", ["feat: first"]);
    const first = appendChangelog("", entry);
    expect(first).toContain("# Changelog");
    expect(first).toContain("- feat: first");
    expect(appendChangelog(first, entry)).toBe(first);
    const next = appendChangelog(
      first,
      changelogEntry("0.2.0", "2026-02-01", []),
    );
    expect(next.indexOf("0.2.0")).toBeLessThan(next.indexOf("0.1.0"));
    expect(next).toContain("Release build.");
  });
});

describe("pack and publish", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function fixtureWidget(): string {
    const dir = mkdtempSync(join(tmpdir(), "pw-widget-fixture-"));
    dirs.push(dir);
    mkdirSync(join(dir, "dist"));
    for (const file of ["index.js", "index.d.ts", "support-widget.global.js"]) {
      writeFileSync(join(dir, "dist", file), "export {};\n");
    }
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    writeFileSync(join(dir, "LICENSE"), "fixture\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify(widgetManifest));
    return dir;
  }

  test("stages, packs, and verifies a tarball that passes every check", () => {
    const packed = packWidget(fixtureWidget());
    dirs.push(packed.workDir);
    expect(packed.tarball.endsWith(".tgz")).toBe(true);
    expect(packed.manifest.devDependencies).toBeUndefined();
    expect(failing(verifyManifest(packed.manifest, packed.entries))).toEqual(
      [],
    );
    expect(listFiles(join(packed.workDir, "extract", "package")).length).toBe(
      packed.entries.length,
    );
  });

  test("publishes through bun with a scoped npmrc and masks the token", () => {
    const packed = packWidget(fixtureWidget());
    dirs.push(packed.workDir);
    let seen: { command: string[]; cwd: string } | undefined;
    const run: Runner = (command, options) => {
      seen = { command, cwd: options.cwd };
      return { status: 0, output: "published with secret-token" };
    };
    const registry = {
      ...REGISTRIES[0],
      url: "http://127.0.0.1:4873",
    } as never;
    const result = publishTarball({
      packed,
      registry,
      token: "secret-token",
      run,
    });
    expect(result.outcome).toBe("published");
    expect(result.output).not.toContain("secret-token");
    expect(seen?.command).toContain("--registry");
    expect(seen?.command).not.toContain("--dry-run");
    const npmrc = join(seen?.cwd as string, ".npmrc");
    expect(readFileSync(npmrc, "utf8")).toContain("_authToken=secret-token");
  });

  test("treats an already published version as success and others as failure", () => {
    const packed = packWidget(fixtureWidget());
    dirs.push(packed.workDir);
    const registry = REGISTRIES[1] as never;
    const exists: Runner = () => ({
      status: 1,
      output: "403 You cannot publish over the previously published versions",
    });
    const broken: Runner = () => ({ status: 1, output: "ECONNREFUSED" });
    expect(
      publishTarball({ packed, registry, token: "t", run: exists }).outcome,
    ).toBe("already-published");
    expect(
      publishTarball({ packed, registry, token: "t", run: broken }).outcome,
    ).toBe("failed");
    const dry = publishTarball({
      packed,
      registry,
      token: "",
      dryRun: true,
      run: (command) => ({ status: 0, output: command.join(" ") }),
    });
    expect(dry.output).toContain("--dry-run");
  });
});

describe("the packed widget manifest", () => {
  test("is public with a repository, license, and peers", () => {
    const pkg = widgetManifest as Packed["manifest"];
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.license).toBeTruthy();
    expect(pkg.peerDependencies).toEqual({
      react: ">=18",
      "react-dom": ">=18",
    });
  });
});

describe("integrity, registry state, and the release decision", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function widget(content = "export {};\n"): string {
    const dir = mkdtempSync(join(tmpdir(), "pw-widget-det-"));
    dirs.push(dir);
    mkdirSync(join(dir, "dist"));
    for (const file of ["index.js", "index.d.ts", "support-widget.global.js"]) {
      writeFileSync(join(dir, "dist", file), content);
    }
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    writeFileSync(join(dir, "LICENSE"), "fixture\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify(widgetManifest));
    return dir;
  }

  const npm = REGISTRIES[0] as Registry;
  const gh = REGISTRIES[1] as Registry;
  const local = { integrity: "sha512-AAA", shasum: "aaa" };
  const same = {
    state: "present",
    integrity: "sha512-AAA",
    shasum: "aaa",
  } as const;
  const other = {
    state: "present",
    integrity: "sha512-BBB",
    shasum: "bbb",
  } as const;

  test("an unchanged tree packs to the same integrity, a changed tree to another", async () => {
    const first = packWidget(widget());
    await Bun.sleep(1100);
    const second = packWidget(widget());
    const changed = packWidget(widget("export const changed = 1;\n"));
    dirs.push(first.workDir, second.workDir, changed.workDir);
    expect(computeIntegrity(second.tarball)).toEqual(
      computeIntegrity(first.tarball),
    );
    expect(computeIntegrity(changed.tarball).integrity).not.toBe(
      computeIntegrity(first.tarball).integrity,
    );
    expect(computeIntegrity(first.tarball).integrity).toMatch(/^sha512-/);
  });

  test("decision table: absent everywhere publishes to both", () => {
    expect(
      decideRelease({
        version: "1.0.0",
        local,
        infos: [
          { registry: npm, info: { state: "absent" } },
          { registry: gh, info: { state: "absent" } },
        ],
      }),
    ).toEqual({
      action: "go",
      registries: { npm: "publish", github: "publish" },
    });
  });

  test("decision table: an identical tarball marks that registry done", () => {
    expect(
      decideRelease({
        version: "1.0.0",
        local,
        infos: [
          { registry: npm, info: same },
          { registry: gh, info: { state: "absent" } },
        ],
      }),
    ).toEqual({ action: "go", registries: { npm: "done", github: "publish" } });
  });

  test("decision table: a different tarball on either registry aborts before anything is sent", () => {
    const absent = { state: "absent" } as const;
    for (const infos of [
      [
        { registry: npm, info: other },
        { registry: gh, info: absent },
      ],
      [
        { registry: npm, info: absent },
        { registry: gh, info: other },
      ],
    ]) {
      const decision = decideRelease({ version: "1.0.0", local, infos });
      expect(decision.action).toBe("abort");
      expect((decision as { reasons: string[] }).reasons.join(" ")).toContain(
        "different content; bump the version",
      );
    }
  });

  test("decision table: a registry error aborts, and a published registry that lost the tarball aborts a retry", () => {
    const failed = decideRelease({
      version: "1.0.0",
      local,
      infos: [
        {
          registry: npm,
          info: { state: "error", message: "npmjs is unreachable" },
        },
        { registry: gh, info: { state: "absent" } },
      ],
    });
    expect(failed).toEqual({
      action: "abort",
      reasons: ["npmjs is unreachable"],
    });
    const lost = decideRelease({
      version: "1.0.0",
      local,
      published: ["npm"],
      infos: [
        { registry: npm, info: { state: "absent" } },
        { registry: gh, info: { state: "absent" } },
      ],
    });
    expect(lost.action).toBe("abort");
  });

  test("the comparison falls back to the shasum when a registry has no integrity", () => {
    expect(sameContent(local, { state: "present", shasum: "aaa" })).toBe(true);
    expect(sameContent(local, { state: "present", shasum: "zzz" })).toBe(false);
    expect(sameContent(local, { state: "absent" })).toBe(false);
  });

  test("fetchVersionInfo maps registry answers to a state", async () => {
    const answer = (status: number, body?: unknown): typeof fetch =>
      (async () =>
        new Response(body === undefined ? "" : JSON.stringify(body), {
          status,
        })) as never;
    const info = (fetcher: typeof fetch, token = "t") =>
      fetchVersionInfo({ registry: npm, token, version: "1.0.0", fetcher });
    expect(await info(answer(404))).toEqual({ state: "absent" });
    expect((await info(answer(401))).state).toBe("error");
    expect((await info(answer(500))).state).toBe("error");
    expect(
      await info(
        answer(200, {
          versions: {
            "1.0.0": { dist: { integrity: "sha512-AAA", shasum: "aaa" } },
          },
        }),
      ),
    ).toEqual({ state: "present", integrity: "sha512-AAA", shasum: "aaa" });
    expect(await info(answer(200, { versions: {} }), "")).toEqual({
      state: "absent",
    });
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(((await info(down)) as { message: string }).message).toContain(
      "unreachable",
    );
  });

  test("the release manifest keeps the tarball, verifies it, and records published registries", () => {
    const root = mkdtempSync(join(tmpdir(), "pw-release-root-"));
    dirs.push(root);
    const packed = packWidget(widget());
    dirs.push(packed.workDir);
    const integrity = computeIntegrity(packed.tarball);
    const saved = saveRelease({
      root,
      packed,
      version: "0.1.0",
      integrity,
      published: [],
    });
    expect(loadRelease(root, "0.1.0")?.integrity).toBe(integrity.integrity);
    const marked = markPublished(root, saved, "npm");
    expect(marked.published).toEqual(["npm"]);
    expect(loadRelease(root, "0.1.0")?.published).toEqual(["npm"]);
    expect(loadRelease(root, "9.9.9")).toBeUndefined();
    writeFileSync(saved.tarball, "tampered");
    expect(loadRelease(root, "0.1.0")).toBeUndefined();
  });
});
