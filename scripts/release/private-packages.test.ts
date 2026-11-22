import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const PUBLISHED = "@pressw-llc/support-react";

function manifests(): { name: string; path: string; private?: boolean }[] {
  const out = [{ path: "package.json" }];
  for (const group of ["modules", "apps", "examples"]) {
    for (const entry of readdirSync(join(root, group), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        out.push({ path: `${group}/${entry.name}/package.json` });
      }
    }
  }
  out.push({ path: "e2e/package.json" });
  return out.flatMap(({ path }) => {
    try {
      const pkg = JSON.parse(readFileSync(join(root, path), "utf8"));
      return [{ ...pkg, path }];
    } catch {
      return [];
    }
  });
}

describe("publish guard", () => {
  test("only the widget package is publishable", () => {
    const publishable = manifests()
      .filter((pkg) => pkg.private !== true)
      .map((pkg) => pkg.name);
    expect(publishable).toEqual([PUBLISHED]);
  });

  test("the root workspace and every other package stay private", () => {
    const all = manifests();
    expect(all.length).toBeGreaterThan(10);
    for (const pkg of all.filter((item) => item.name !== PUBLISHED)) {
      expect(pkg.private, pkg.path).toBe(true);
    }
  });

  test("no private package carries a publish config", () => {
    for (const pkg of manifests().filter((item) => item.name !== PUBLISHED)) {
      expect(
        (pkg as { publishConfig?: unknown }).publishConfig,
        pkg.path,
      ).toBeUndefined();
    }
  });
});
