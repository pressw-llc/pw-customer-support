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

const config = `storage: /verdaccio/storage
auth:
  htpasswd:
    file: /verdaccio/storage/htpasswd
    max_users: 10
uplinks: {}
packages:
  "@pressw-llc/*":
    access: $all
    publish: $authenticated
    unpublish: $authenticated
  "**":
    access: $all
    publish: $authenticated
log: { type: stdout, format: pretty, level: warn }
`;

async function startRegistry(registry: Local) {
  mkdirSync(join(registry.dir, "conf"), { recursive: true });
  mkdirSync(join(registry.dir, "storage"), { recursive: true });
  writeFileSync(join(registry.dir, "conf", "config.yaml"), config);
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
    "--allow-existing",
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
    ["bun", "add", `${PACKAGE}@${version}`, "react@18", "react-dom@18"],
    { cwd: dir, env: { ...process.env, GITHUB_TOKEN: undefined } },
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
  assert(
    sha(join(installed, "dist/index.js")) ===
      sha(join(root, "modules/widget/dist/index.js")),
    "installed dist differs from the build",
  );
  return `${PACKAGE}@${pkg.version} installed from ${registry.url}`;
}

try {
  await steps.run("start two Verdaccio registries", async () => {
    await Promise.all(registries.map(startRegistry));
    return registries.map((registry) => registry.url).join(" and ");
  });

  await steps.run("publish refuses to start without both tokens", async () => {
    const result = await exec(releaseArgs(), {
      cwd: root,
      env: { ...releaseEnv(), GH_PACKAGES_TOKEN: undefined },
    });
    assert(result.code !== 0, "publish succeeded without a token");
    assert(
      /missing tokens before anything is sent/.test(result.out),
      result.out,
    );
    const meta = await fetch(
      `${registries[0]?.url}/${PACKAGE.replace("/", "%2f")}`,
    );
    assert(meta.status === 404, "a package reached the registry");
  });

  await steps.run("release --publish pushes one tarball to both", async () => {
    const result = await exec(releaseArgs(), { cwd: root, env: releaseEnv() });
    assert(result.code === 0, result.out);
    assert(/PASS npmjs published/.test(result.out), result.out);
    assert(/PASS GitHub Packages published/.test(result.out), result.out);
    assert(/next: git tag support-react-v/.test(result.out), result.out);
    return "published to both";
  });

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

  await steps.run("a second publish is idempotent", async () => {
    const result = await exec(releaseArgs(), { cwd: root, env: releaseEnv() });
    assert(result.code === 0, result.out);
    assert(/PASS npmjs already-published/.test(result.out), result.out);
    assert(
      /PASS GitHub Packages already-published/.test(result.out),
      result.out,
    );
  });

  await steps.run(
    "a failing second registry prints the retry command",
    async () => {
      await exec(["docker", "stop", registries[1]?.container as string]);
      const result = await exec(releaseArgs(["--only", "github"]), {
        cwd: root,
        env: releaseEnv(),
      });
      assert(result.code !== 0, "publish succeeded against a stopped registry");
      assert(
        /retry: bun run release --publish --only github/.test(result.out),
        result.out,
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
