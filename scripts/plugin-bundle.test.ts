import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginBundle, workspaceImportsIn } from "./plugin-bundle";

const out = mkdtempSync(join(tmpdir(), "pw-plugin-bundle-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("plugin bundle", () => {
  test("lays out the plugin directory with one self-contained script", async () => {
    const result = await buildPluginBundle(out);
    expect(result.cliBytes).toBeGreaterThan(10_000);
    for (const path of [
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "README.md",
      "commands/watch.md",
      "skills/laptop-triage/SKILL.md",
      "bin/pw-support",
      "lib/cli.js",
    ]) {
      expect(existsSync(join(out, path)), path).toBe(true);
    }
    const bundle = readFileSync(join(out, "lib", "cli.js"), "utf8");
    expect(workspaceImportsIn(bundle)).toEqual([]);
    expect(workspaceImportsIn('import x from "@pw-support/db";')).toEqual([
      "@pw-support/db",
    ]);
  });

  test("the bundled CLI runs without the workspace on disk", async () => {
    const run = (...args: string[]) =>
      Bun.spawnSync(["sh", join(out, "bin", "pw-support"), ...args], {
        cwd: out,
        env: { PATH: process.env.PATH ?? "", HOME: out },
      });
    const help = run("help");
    expect(help.exitCode).toBe(0);
    expect(help.stderr.toString()).toContain("usage: pw-support");
    const submit = run("submit-server");
    expect(submit.exitCode).toBe(1);
    expect(submit.stderr.toString()).toContain("submit-server <config>");
  });

  test("the launcher points at the bundled script", () => {
    const launcher = readFileSync(join(out, "bin", "pw-support"), "utf8");
    expect(launcher).toContain('"$ROOT/lib/cli.js"');
  });
});
