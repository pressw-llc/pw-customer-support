import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export interface EnvEntry {
  key: string;
  value: string;
  line: number;
}

export interface SetOptions {
  comment?: string;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`invalid key "${key}": use ${KEY_PATTERN.source}`);
  }
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function formatValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("values may not contain newlines");
  if (value === "" || !/[\s#"'\\]/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    const close = trimmed.lastIndexOf('"');
    if (close > 0) {
      return trimmed.slice(1, close).replace(/\\(["\\])/g, "$1");
    }
  }
  if (trimmed.startsWith("'")) {
    const close = trimmed.lastIndexOf("'");
    if (close > 0) return trimmed.slice(1, close);
  }
  return trimmed.replace(/\s+#.*$/, "");
}

export function parseEnv(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  splitLines(text).forEach((line, index) => {
    const match = ASSIGNMENT.exec(line);
    if (!match || line.trimStart().startsWith("#")) return;
    entries.push({
      key: match[1] as string,
      value: parseValue(match[2] as string),
      line: index,
    });
  });
  return entries;
}

export function findEntry(text: string, key: string): EnvEntry | undefined {
  return parseEnv(text).find((entry) => entry.key === key);
}

function commentLine(comment: string): string {
  const flat = comment.replace(/[\r\n]+/g, " ").trim();
  return `# ${flat.replace(/^#\s*/, "")}`;
}

function isComment(line: string | undefined): boolean {
  return line?.trimStart().startsWith("#") === true;
}

export function upsertKey(
  text: string,
  key: string,
  value: string,
  options: SetOptions = {},
): string {
  assertKey(key);
  const lines = splitLines(text);
  const rendered = `${key}=${formatValue(value)}`;
  const existing = findEntry(text, key);
  if (!existing) {
    if (options.comment !== undefined) lines.push(commentLine(options.comment));
    lines.push(rendered);
    return joinLines(lines);
  }
  lines[existing.line] = rendered;
  if (options.comment !== undefined) {
    const above = existing.line - 1;
    if (isComment(lines[above])) {
      lines[above] = commentLine(options.comment);
    } else {
      lines.splice(existing.line, 0, commentLine(options.comment));
    }
  }
  return joinLines(lines);
}

export function ensureKey(text: string, key: string, comment?: string): string {
  if (findEntry(text, key) && comment === undefined) return text;
  const current = findEntry(text, key)?.value ?? "";
  return upsertKey(text, key, current, { comment });
}

export function removeKey(text: string, key: string): string {
  assertKey(key);
  const existing = findEntry(text, key);
  if (!existing) return text;
  const lines = splitLines(text);
  const start = isComment(lines[existing.line - 1])
    ? existing.line - 1
    : existing.line;
  lines.splice(start, existing.line - start + 1);
  return joinLines(lines);
}

export function syncLocal(example: string, local: string): string {
  const present = new Set(parseEnv(local).map((entry) => entry.key));
  let next = local;
  for (const entry of parseEnv(example)) {
    if (!present.has(entry.key)) {
      next = upsertKey(next, entry.key, entry.value);
    }
  }
  return next;
}

export function missingKeys(example: string, local: string): string[] {
  const present = new Set(parseEnv(local).map((entry) => entry.key));
  return parseEnv(example)
    .map((entry) => entry.key)
    .filter((key) => !present.has(key));
}

export function describeKeys(example: string, local: string | null): string[] {
  const localEntries = new Map(
    parseEnv(local ?? "").map((entry) => [entry.key, entry.value]),
  );
  return parseEnv(example).map((entry) => {
    const exampleState = entry.value === "" ? "blank" : "default";
    const localValue = localEntries.get(entry.key);
    const localState =
      local === null || localValue === undefined
        ? "missing"
        : localValue === ""
          ? "blank"
          : "set";
    return `${entry.key} example: ${exampleState} local: ${localState}`;
  });
}

export interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readStdin: () => Promise<string>;
}

interface Parsed {
  command: string;
  positional: string[];
  flags: Set<string>;
  comment?: string;
  dir: string;
}

const defaultDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]): Parsed {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Set<string>();
  let comment: string | undefined;
  let dir = defaultDir;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--comment") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--comment needs a value");
      comment = next;
    } else if (arg === "--dir") {
      const next = rest[++i];
      if (next === undefined) throw new Error("--dir needs a path");
      dir = resolve(next);
    } else if (arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags, comment, dir };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function writeLocal(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeExample(path: string, text: string): void {
  writeFileSync(path, text);
}

async function runSet(parsed: Parsed, io: Io, paths: Paths): Promise<number> {
  const [target] = parsed.positional;
  if (!target) throw new Error("set needs a KEY");
  const eq = target.indexOf("=");
  const key = eq === -1 ? target : target.slice(0, eq);
  assertKey(key);
  const inline = eq === -1 ? undefined : target.slice(eq + 1);
  const exampleOnly = parsed.flags.has("--example-only");
  const localOnly = parsed.flags.has("--local-only");
  if (exampleOnly && localOnly) {
    throw new Error("use only one of --example-only and --local-only");
  }
  let value = inline;
  if (parsed.flags.has("--stdin")) {
    value = (await io.readStdin()).replace(/\r?\n$/, "");
  }
  const secret = parsed.flags.has("--secret");
  const written: string[] = [];
  if (!localOnly) {
    const text = readIfExists(paths.example) ?? "";
    const exampleValue = secret ? "" : value;
    const next =
      exampleValue === undefined
        ? ensureKey(text, key, parsed.comment)
        : upsertKey(text, key, exampleValue, { comment: parsed.comment });
    writeExample(paths.example, next);
    written.push(".env.example");
  }
  if (!exampleOnly) {
    const text = readIfExists(paths.local) ?? "";
    const next =
      value === undefined ? ensureKey(text, key) : upsertKey(text, key, value);
    writeLocal(paths.local, next);
    written.push(".env.local");
  }
  io.stdout(`set ${key} in ${written.join(" and ")}`);
  return 0;
}

function runSync(io: Io, paths: Paths): number {
  const example = readIfExists(paths.example);
  if (example === null) {
    io.stderr(".env.example is missing");
    return 1;
  }
  const local = readIfExists(paths.local);
  const missing = missingKeys(example, local ?? "");
  writeLocal(paths.local, syncLocal(example, local ?? ""));
  io.stdout(
    missing.length === 0
      ? ".env.local is up to date"
      : `added to .env.local: ${missing.join(", ")}`,
  );
  return 0;
}

function runUnset(parsed: Parsed, io: Io, paths: Paths): number {
  const [key] = parsed.positional;
  if (!key) throw new Error("unset needs a KEY");
  assertKey(key);
  const exampleOnly = parsed.flags.has("--example-only");
  const localOnly = parsed.flags.has("--local-only");
  if (exampleOnly && localOnly) {
    throw new Error("use only one of --example-only and --local-only");
  }
  const removed: string[] = [];
  const example = readIfExists(paths.example);
  if (!localOnly && example !== null && findEntry(example, key)) {
    writeExample(paths.example, removeKey(example, key));
    removed.push(".env.example");
  }
  const local = readIfExists(paths.local);
  if (!exampleOnly && local !== null && findEntry(local, key)) {
    writeLocal(paths.local, removeKey(local, key));
    removed.push(".env.local");
  }
  io.stdout(
    removed.length === 0
      ? `${key} not found`
      : `removed ${key} from ${removed.join(" and ")}`,
  );
  return 0;
}

function runList(io: Io, paths: Paths): number {
  const example = readIfExists(paths.example);
  if (example === null) {
    io.stderr(".env.example is missing");
    return 1;
  }
  for (const line of describeKeys(example, readIfExists(paths.local))) {
    io.stdout(line);
  }
  return 0;
}

function runCheck(io: Io, paths: Paths): number {
  const example = readIfExists(paths.example);
  if (example === null) {
    io.stderr(".env.example is missing");
    return 1;
  }
  const local = readIfExists(paths.local);
  if (local === null) return 0;
  const missing = missingKeys(example, local);
  if (missing.length === 0) return 0;
  io.stderr(`.env.local lacks: ${missing.join(", ")}`);
  io.stderr("run: bun run env sync");
  return 1;
}

interface Paths {
  example: string;
  local: string;
}

export const USAGE = [
  "usage: bun run env <command>",
  "  set <KEY>[=<VALUE>] [--secret] [--stdin] [--comment <text>] [--example-only] [--local-only]",
  "  sync",
  "  unset <KEY> [--example-only|--local-only]",
  "  list",
  "  check",
  "  --dir <path> overrides the repository root",
].join("\n");

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const paths: Paths = {
      example: join(parsed.dir, ".env.example"),
      local: join(parsed.dir, ".env.local"),
    };
    switch (parsed.command) {
      case "set":
        return await runSet(parsed, io, paths);
      case "sync":
        return runSync(io, paths);
      case "unset":
        return runUnset(parsed, io, paths);
      case "list":
        return runList(io, paths);
      case "check":
        return runCheck(io, paths);
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "unknown error");
    return 1;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    readStdin: () => Bun.stdin.text(),
  });
  process.exit(code);
}
