import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { findViolations, main } from "./lint-boundaries";

const fixtures = join(import.meta.dir, "fixtures");
const script = join(import.meta.dir, "lint-boundaries.ts");

function lint(root: string) {
  return Bun.spawnSync(["bun", script, "--root", root], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("findViolations", () => {
  test("reports deep package imports, relative climbs, and dynamic imports", () => {
    const violations = findViolations(join(fixtures, "boundary-violations"));
    const specifiers = violations.map((v) => v.specifier).sort();
    expect(specifiers).toEqual([
      "../../db/src/internal",
      "../../widget/src/index",
      "@pressw-llc/support-react/src/index",
      "@pw-support/db/src/internal",
      "@pw-support/db/src/internal",
      "@pw-support/db/undeclared",
    ]);
    expect(violations.every((v) => v.line > 0)).toBe(true);
  });

  test("a declared exports subpath is allowed, an undeclared or src subpath is not", () => {
    const violations = findViolations(join(fixtures, "boundary-violations"));
    const specifiers = violations.map((v) => v.specifier);
    expect(specifiers).not.toContain("@pw-support/db/testing");
    expect(specifiers).toContain("@pw-support/db/undeclared");
    expect(specifiers).toContain("@pw-support/db/src/internal");
  });

  test("accepts entrypoint imports and imports inside one module", () => {
    expect(findViolations(join(fixtures, "boundary-clean"))).toEqual([]);
  });

  test("finds none in the real workspace", () => {
    expect(findViolations(join(import.meta.dir, ".."))).toEqual([]);
  });
});

describe("lint-boundaries command", () => {
  test("exits non-zero on a planted deep import", () => {
    const result = lint(join(fixtures, "boundary-violations"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("deep import");
  });

  test("exits zero on a clean tree", () => {
    const result = lint(join(fixtures, "boundary-clean"));
    expect(result.exitCode).toBe(0);
  });
});

describe("main", () => {
  test("returns 1 and reports each violation", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const code = main(["--root", join(fixtures, "boundary-violations")]);
    expect(code).toBe(1);
    expect(errors.mock.calls.length).toBe(7);
    errors.mockRestore();
  });

  test("returns 0 on a clean tree", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(main(["--root", join(fixtures, "boundary-clean")])).toBe(0);
    log.mockRestore();
  });

  test("defaults the root to the working directory", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(main([])).toBe(0);
    log.mockRestore();
  });
});
