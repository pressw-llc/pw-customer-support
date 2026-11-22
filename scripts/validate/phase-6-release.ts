import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./free-port";
import { assert, exec, Steps, waitFor } from "./steps";

const root = join(import.meta.dir, "..", "..");
const PACKAGE = "@pressw-llc/support-react";
const IMAGE = "verdaccio/verdaccio:5.33.0";
const SUFFIX = crypto.randomUUID().slice(0, 8);
const version = (
  JSON.parse(
    readFileSync(join(root, "modules/widget/package.json"), "utf8"),
  ) as { version: string }
).version;

interface Local {
  id: "npm" | "github";
  container: string;
  port: number;
  url: string;
  dir: string;
  token: string;
}

const steps = new Steps();
const manifestFile = join(root, ".release", `manifest-${version}.json`);
let firstIntegrity = "";
const work = mkdtempSync(join(tmpdir(), "pw-release-rehearsal-"));
const registries: Local[] = (["npm", "github"] as const).map((id) => {
  const port = freePort();
  return {
    id,
    container: `pw-support-rehearsal-${id}-${SUFFIX}`,
    port,
    url: `http://127.0.0.1:${port}`,
    dir: join(work, id),
    token: "",
  };
});

const configFor = (publish: string) => `storage: /verdaccio/storage
auth:
  htpasswd:
    file: /verdaccio/storage/htpasswd
    max_users: 10
uplinks: {}
packages:
  "@pressw-llc/*":
    access: $all
    publish: ${publish}
    unpublish: ${publish}
  "**":
    access: $all
    publish: $authenticated
log: { type: stdout, format: pretty, level: warn }
`;

async function startRegistry(registry: Local, publish = "$authenticated") {
  mkdirSync(join(registry.dir, "conf"), { recursive: true });
  mkdirSync(join(registry.dir, "storage"), { recursive: true });
  writeFileSync(join(registry.dir, "conf", "config.yaml"), configFor(publish));
  await exec(["chmod", "-R", "777", registry.dir]);
  const started = await exec([
    "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    registry.container,
    "-p",
    `127.0.0.1:${registry.port}:4873`,
    "-v",
    `${join(registry.dir, "conf")}:/verdaccio/conf`,
    "-v",
    `${join(registry.dir, "storage")}:/verdaccio/storage`,
    IMAGE,
  ]);
  assert(started.code === 0, started.out);
  await waitFor(
    async () => (await fetch(`${registry.url}/-/ping`)).ok,
    `${registry.container} ping`,
  );
  if (registry.token) return;
  const response = await fetch(
    `${registry.url}/-/user/org.couchdb.user:rehearsal`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "rehearsal",
        password: `throwaway-${SUFFIX}`,
        email: "rehearsal@example.test",
      }),
    },
  );
  const body = (await response.json()) as { token?: string };
  assert(response.ok && body.token, `user create failed ${response.status}`);
  registry.token = body.token;
}

async function stopRegistries() {
  for (const registry of registries) {
    await exec(["docker", "rm", "-f", registry.container]);
  }
}

function releaseEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    NPM_TOKEN: registries[0]?.token,
    GH_PACKAGES_TOKEN: registries[1]?.token,
    GITHUB_TOKEN: undefined,
  };
}

function releaseArgs(extra: string[] = []): string[] {
  return [
    "bun",
    "run",
    "release",
    "--publish",
    "--no-changelog",
    "--npm-registry",
    registries[0]?.url as string,
    "--gh-registry",
    registries[1]?.url as string,
    "--api-url",
    "http://127.0.0.1:8787",
    ...extra,
  ];
}

async function metadata(registry: Local) {
  const response = await fetch(
    `${registry.url}/${PACKAGE.replace("/", "%2f")}`,
    { headers: { authorization: `Bearer ${registry.token}` } },
  );
  assert(response.ok, `${registry.id} metadata ${response.status}`);
  return (await response.json()) as {
    versions: Record<string, { dist: { integrity?: string; shasum: string } }>;
  };
}

async function consumer(registry: Local, style: "bunfig" | "npmrc") {
  const dir = mkdtempSync(join(work, `consumer-${registry.id}-`));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "rehearsal-app", private: true, type: "module" }),
  );
  if (style === "bunfig") {
    writeFileSync(
      join(dir, "bunfig.toml"),
      `[install.scopes]\n"@pressw-llc" = { url = "${registry.url}/", token = "${registry.token}" }\n`,
    );
  } else {
    writeFileSync(
      join(dir, ".npmrc"),
      `@pressw-llc:registry=${registry.url}/\n//127.0.0.1:${registry.port}/:_authToken=${registry.token}\n`,
    );
  }
  const install = await exec(
    [
      "bun",
      "add",
      "--no-cache",
      `${PACKAGE}@${version}`,
      "react@18",
      "react-dom@18",
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        GITHUB_TOKEN: undefined,
        BUN_INSTALL_CACHE_DIR: join(dir, ".bun-cache"),
      },
    },
  );
  assert(install.code === 0, `bun add failed: ${install.out}`);

  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src", "main.tsx"),
    `import { createRoot } from "react-dom/client";
import { SupportWidget } from "${PACKAGE}";

createRoot(document.body).render(
  <SupportWidget projectKey="pk_rehearsal" userEmail="rehearsal@example.test" />,
);
`,
  );
  const built = await exec(
    ["bun", "build", "src/main.tsx", "--outdir", "dist", "--target", "browser"],
    { cwd: dir },
  );
  assert(built.code === 0, `app build failed: ${built.out}`);
  assert(existsSync(join(dir, "dist", "main.js")), "no app bundle");

  const installed = join(dir, "node_modules", ...PACKAGE.split("/"));
  const pkg = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  ) as { version: string; private?: boolean };
  assert(pkg.version === version, `installed ${pkg.version}`);
  assert(pkg.private !== true, "installed package is private");
  for (const file of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/support-widget.global.js",
    "README.md",
    "LICENSE",
  ]) {
    assert(existsSync(join(installed, file)), `missing ${file}`);
  }
  const sha = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const savedTarball = (
    JSON.parse(readFileSync(manifestFile, "utf8")) as { tarball: string }
  ).tarball;
  const packedIndex = Bun.spawnSync([
    "tar",
    "-xzOf",
    savedTarball,
    "package/dist/index.js",
  ]).stdout;
  const packedSha = createHash("sha256").update(packedIndex).digest("hex");
  const installedSha = sha(join(installed, "dist/index.js"));
  assert(
    installedSha === packedSha,
    `installed dist ${installedSha} differs from the saved release tarball ${packedSha} (${savedTarball}, ${packedIndex.length} bytes)`,
  );
  return `${PACKAGE}@${pkg.version} installed from ${registry.url}`;
}

rmSync(join(root, ".release"), { recursive: true, force: true });

try {
  await steps.run("start two Verdaccio registries", async () => {
    await startRegistry(registries[0] as Local);
    await startRegistry(registries[1] as Local, "nobody");
    return `${registries[0]?.url} and ${registries[1]?.url} (the second refuses publishing for now)`;
  });

  await steps.run("publish refuses to start without both tokens", async () => {
    const result = await exec(releaseArgs(), {
      cwd: root,
      env: { ...releaseEnv(), GH_PACKAGES_TOKEN: undefined },
    });
    assert(result.code !== 0, "publish succeeded without a token");
    assert(/nothing was sent/.test(result.out), result.out);
    assert(/missing token GitHub Packages/.test(result.out), result.out);
    const meta = await fetch(
      `${registries[0]?.url}/${PACKAGE.replace("/", "%2f")}`,
    );
    assert(meta.status === 404, "a package reached the registry");
  });

  await steps.run(
    "a failing second registry leaves one registry published and prints the retry command",
    async () => {
      const result = await exec(releaseArgs(), {
        cwd: root,
        env: releaseEnv(),
      });
      assert(
        result.code !== 0,
        "publish succeeded against a refusing registry",
      );
      assert(/PASS npmjs published/.test(result.out), result.out);
      assert(
        /retry with the same tarball: bun run release --publish --only github/.test(
          result.out,
        ),
        result.out,
      );
      const saved = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        integrity: string;
        published: string[];
      };
      assert(saved.published.join() === "npm", `published ${saved.published}`);
      firstIntegrity = saved.integrity;
      const first = await metadata(registries[0] as Local);
      assert(first.versions[version], "first registry lacks the version");
      return `integrity ${saved.integrity.slice(0, 24)}...`;
    },
  );

  await steps.run(
    "a changed build with the same version is refused before anything is sent",
    async () => {
      const before = (await metadata(registries[0] as Local)).versions[version]
        ?.dist.shasum;
      const result = await exec(
        releaseArgs().map((arg) =>
          arg === "http://127.0.0.1:8787" ? "http://127.0.0.1:8799" : arg,
        ),
        { cwd: root, env: releaseEnv() },
      );
      assert(result.code !== 0, "a changed build was published");
      assert(
        /different content; bump the version/.test(result.out),
        result.out.slice(-600),
      );
      assert(/nothing was sent/.test(result.out), result.out.slice(-600));
      const after = (await metadata(registries[0] as Local)).versions[version]
        ?.dist.shasum;
      assert(before === after, "the first registry changed");
      const second = await fetch(
        `${registries[1]?.url}/${PACKAGE.replace("/", "%2f")}`,
      );
      assert(second.status === 404, "the second registry received a package");
      const restored = await exec(
        ["bun", "run", "--filter", PACKAGE, "build"],
        {
          cwd: root,
          env: { ...process.env, SUPPORT_API_URL: "http://127.0.0.1:8787" },
        },
      );
      assert(restored.code === 0, restored.out);
    },
  );

  await steps.run(
    "the retry publishes the identical tarball without rebuilding",
    async () => {
      await exec(["docker", "rm", "-f", registries[1]?.container as string]);
      await startRegistry(registries[1] as Local, "$authenticated");
      const result = await exec(releaseArgs(["--only", "github"]), {
        cwd: root,
        env: releaseEnv(),
      });
      assert(result.code === 0, result.out.slice(-800));
      assert(/reusing .*support-react-.*\.tgz/.test(result.out), result.out);
      assert(!/\[release\] build/.test(result.out), "the retry rebuilt");
      assert(
        /PASS npmjs already holds the identical tarball|PASS GitHub Packages published/.test(
          result.out,
        ),
        result.out,
      );
      const [npm, gh] = await Promise.all(registries.map(metadata));
      const a = npm?.versions[version]?.dist;
      const b = gh?.versions[version]?.dist;
      assert(a && b, "version missing");
      assert(a.shasum === b.shasum, "tarball checksums differ");
      assert(
        a.integrity === firstIntegrity && b.integrity === firstIntegrity,
        `integrity differs: ${a.integrity} ${b.integrity} ${firstIntegrity}`,
      );
      return `both hold ${firstIntegrity.slice(0, 24)}...`;
    },
  );

  await steps.run("both registries hold the same tarball", async () => {
    const [npm, gh] = await Promise.all(registries.map(metadata));
    const a = npm?.versions[version]?.dist;
    const b = gh?.versions[version]?.dist;
    assert(a && b, "version missing");
    assert(a.shasum === b.shasum, "tarball checksums differ");
    return `shasum ${a.shasum}`;
  });

  await steps.run("a fresh app installs and builds from registry A", () =>
    consumer(registries[0] as Local, "bunfig"),
  );
  await steps.run("a fresh app installs and builds from registry B", () =>
    consumer(registries[1] as Local, "npmrc"),
  );

  await steps.run(
    "an unchanged tree rebuilds to the same tarball and a second publish is a no-op",
    async () => {
      const result = await exec(releaseArgs(), {
        cwd: root,
        env: releaseEnv(),
      });
      assert(result.code === 0, result.out.slice(-800));
      assert(
        /PASS npmjs already holds the identical tarball/.test(result.out),
        result.out.slice(-800),
      );
      assert(
        /PASS GitHub Packages already holds the identical tarball/.test(
          result.out,
        ),
        result.out.slice(-800),
      );
    },
  );

  await steps.run(
    "publish plan against the real registry URLs, no tokens",
    async () => {
      const result = await exec(["bun", "run", "release", "--no-changelog"], {
        cwd: root,
        env: {
          ...process.env,
          NPM_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          GH_PACKAGES_TOKEN: undefined,
        },
      });
      assert(result.code === 0, result.out);
      assert(result.out.includes("https://registry.npmjs.org"), result.out);
      assert(result.out.includes("https://npm.pkg.github.com"), result.out);
      assert(/DRY RUN complete; nothing was sent/.test(result.out), result.out);
      const plan = result.out
        .split("\n")
        .filter((line) => /packed|@pressw-llc\/support-react@/.test(line));
      return `\n${plan.slice(0, 6).join("\n")}`;
    },
  );
} finally {
  await stopRegistries();
  rmSync(work, { recursive: true, force: true });
}

process.exit(steps.summarize());
