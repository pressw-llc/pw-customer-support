import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  dir: string;
  file: string;
  name: string | undefined;
  description: string | undefined;
  body: string;
}

export function parseFrontmatter(text: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const match = text.match(
    /^---\r?\n(?:\s*\r?\n)?([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/,
  );
  if (!match) return { body: text };
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (pair) fields[pair[1] as string] = (pair[2] as string).trim();
  }
  return {
    name: fields.name,
    description: fields.description,
    body: match[2] as string,
  };
}

export function readSkill(skillDir: string): Skill | undefined {
  const file = join(skillDir, "SKILL.md");
  if (!existsSync(file)) return undefined;
  const parsed = parseFrontmatter(readFileSync(file, "utf8"));
  return {
    dir: skillDir,
    file,
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
  };
}

export function skillsIn(skillsRoot: string): Skill[] {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readSkill(join(skillsRoot, entry.name)) ?? []);
}

export function subdirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules",
    )
    .map((entry) => entry.name);
}

const PATH_EXTENSIONS = /\.(ts|tsx|json|md|sql|yml|yaml|toml|sh)$/;

export function pathMentions(body: string): string[] {
  const spans = [...body.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map(
    (match) => match[1] as string,
  );
  const found = new Set<string>();
  for (const span of spans) {
    const token = span.trim();
    if (/[\s<>*${}()=,|]/.test(token) || /^(https?:|@|-)/.test(token)) continue;
    const looksLikePath =
      PATH_EXTENSIONS.test(token) ||
      /^[\w.-]+(\/[\w.-]+)+\/?$/.test(token) ||
      /^[\w.-]+\/$/.test(token);
    if (looksLikePath && !token.startsWith("/") && !token.startsWith("~")) {
      found.add(token.replace(/\/$/, ""));
    }
  }
  return [...found];
}

export function resolvesAnywhere(
  mention: string,
  bases: string[],
  exists: (path: string) => boolean = existsSync,
): boolean {
  return bases.some((base) => exists(join(base, mention)));
}

export function missingPaths(
  skill: Skill,
  bases: string[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  return pathMentions(skill.body).filter(
    (mention) => !resolvesAnywhere(mention, bases, exists),
  );
}

export function duplicates(names: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    if (seen.has(name)) dupes.add(name);
    seen.add(name);
  }
  return [...dupes];
}

export function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
