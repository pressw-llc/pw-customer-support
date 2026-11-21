import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = join(import.meta.dir, "..", ".githooks", "commit-msg");
const dir = mkdtempSync(join(tmpdir(), "commit-msg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(subject: string): number {
  const file = join(dir, "message");
  writeFileSync(file, `${subject}\n\nbody\n`);
  return Bun.spawnSync(["sh", hook, file], { stderr: "pipe" }).exitCode;
}

describe("commit-msg hook", () => {
  test.each([
    "feat: add widget",
    "fix(api): handle empty body",
    "chore!: drop node 18",
    "Merge pull request #4 from pressw-llc/branch",
    'Revert "feat: add widget"',
  ])("accepts %p", (subject) => {
    expect(run(subject)).toBe(0);
  });

  test.each([
    "added widget",
    "Feat: capitalised type",
    "feat:missing space",
    "feat: ",
    `feat: ${"x".repeat(70)}`,
  ])("rejects %p", (subject) => {
    expect(run(subject)).toBe(1);
  });
});
