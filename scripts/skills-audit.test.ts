import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  duplicates,
  missingPaths,
  parseFrontmatter,
  pathMentions,
  resolvesAnywhere,
  type Skill,
  skillsIn,
  subdirectories,
} from "./skills-audit";

const root = join(import.meta.dir, "..");

describe("skill audit helpers", () => {
  test("parses frontmatter and reports a missing block", () => {
    const parsed = parseFrontmatter(
      "---\n\nname: a-skill\ndescription: Does a thing.\n---\n\n# Body\n",
    );
    expect(parsed.name).toBe("a-skill");
    expect(parsed.description).toBe("Does a thing.");
    expect(parsed.body).toContain("# Body");
    expect(parseFrontmatter("# no frontmatter").name).toBeUndefined();
  });

  test("extracts path-like inline code and skips commands, urls, and globs", () => {
    const body = [
      "Use `src/app.ts` and `modules/db/migrations` but not `bun run check`.",
      "Skip `https://x.example/a.ts`, `src/*.ts`, `<module>/x.ts`, `@pw-support/db`.",
      "Keep `docs/runbook.md` and `scripts/` once.",
      "```\nfenced/path.ts\n```",
    ].join("\n");
    expect(pathMentions(body)).toEqual([
      "src/app.ts",
      "modules/db/migrations",
      "docs/runbook.md",
      "scripts",
    ]);
  });

  test("resolves a mention against several bases", () => {
    const exists = (path: string) => path === "/repo/modules/x/src/a.ts";
    expect(
      resolvesAnywhere("src/a.ts", ["/repo", "/repo/modules/x"], exists),
    ).toBe(true);
    expect(resolvesAnywhere("src/b.ts", ["/repo"], exists)).toBe(false);
    const skill = { body: "See `src/a.ts` and `src/gone.ts`." } as Skill;
    expect(missingPaths(skill, ["/repo/modules/x"], exists)).toEqual([
      "src/gone.ts",
    ]);
  });

  test("finds duplicate names", () => {
    expect(duplicates(["a", "b", "a", undefined, "b", "c"]).sort()).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("repository skills (A26)", () => {
  const rootSkills = skillsIn(join(root, ".claude", "skills"));
  const moduleDirs = [
    ...subdirectories(join(root, "modules")).map((name) =>
      join(root, "modules", name),
    ),
    ...subdirectories(join(root, "apps")).map((name) =>
      join(root, "apps", name),
    ),
  ];

  test("covers every module and app directory", () => {
    expect(moduleDirs.length).toBeGreaterThanOrEqual(10);
  });

  test("every module and app holds at least one skill with a name and description", () => {
    for (const dir of moduleDirs) {
      const skills = skillsIn(join(dir, ".claude", "skills"));
      expect(skills.length, dir).toBeGreaterThanOrEqual(1);
      for (const skill of skills) {
        expect(skill.name, skill.file).toBeTruthy();
        expect(skill.description, skill.file).toBeTruthy();
        expect(skill.name, skill.file).toBe(
          skill.dir.split("/").at(-1) as string,
        );
        expect(
          (skill.description as string).length,
          skill.file,
        ).toBeGreaterThan(30);
      }
    }
  });

  test("the root holds the pipelines, managed-agents, and repository skills", () => {
    const names = rootSkills.map((skill) => skill.name as string);
    expect(
      names.filter((name) => name.startsWith("pw-pipeline-")).length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      names.filter((name) => name.startsWith("pw-agents-")).length,
    ).toBeGreaterThanOrEqual(8);
    expect(names).toContain("pw-support-repo");
    expect(names).toContain("env-files");
    for (const skill of rootSkills) {
      expect(skill.name, skill.file).toBeTruthy();
      expect(skill.description, skill.file).toBeTruthy();
    }
  });

  test("skill names are unique across the repository", () => {
    const all = [
      ...rootSkills,
      ...moduleDirs.flatMap((dir) => skillsIn(join(dir, ".claude", "skills"))),
      ...skillsIn(join(root, "modules", "plugin", "skills")),
    ];
    expect(duplicates(all.map((skill) => skill.name))).toEqual([]);
  });

  test("module skills mention only paths that exist", () => {
    for (const dir of moduleDirs) {
      for (const skill of skillsIn(join(dir, ".claude", "skills"))) {
        expect(
          missingPaths(skill, [
            dir,
            join(dir, "src"),
            root,
            join(dir, "node_modules"),
            join(root, "node_modules"),
          ]),
          skill.file,
        ).toEqual([]);
      }
    }
  });

  test("the repository skill mentions only paths that exist", () => {
    const skill = rootSkills.find(
      (item) => item.name === "pw-support-repo",
    ) as Skill;
    expect(
      missingPaths(skill, [
        root,
        join(root, ".claude", "skills"),
        join(root, "docs", "plans", "customer-support-v1"),
      ]),
    ).toEqual([]);
  });
});
