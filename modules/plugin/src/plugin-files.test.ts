import { describe, expect, test } from "bun:test";
import {
  accessSync,
  constants,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal plugin variable
const CLI = '"${CLAUDE_PLUGIN_ROOT}/bin/pw-support"';
const SUBCOMMANDS =
  "login|logout|token|headers|watch|submit-server|help|run|start|stop|status";
const BARE_INVOCATION = new RegExp(
  `(?<![\\w/.-])pw-support(?=\\s+(?:${SUBCOMMANDS})\\b)`,
);
const BARE_ALLOWED = /Bash\(\s*"?pw-support/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : walk(path);
    return [path];
  });
}

function pluginFiles(): string[] {
  const dirs = ["commands", "skills", "hooks", "agents"].flatMap((name) => {
    try {
      return walk(join(ROOT, name));
    } catch {
      return [];
    }
  });
  return [
    ...dirs,
    join(ROOT, ".mcp.json"),
    join(ROOT, ".claude-plugin", "plugin.json"),
  ];
}

function frontmatter(text: string): { head: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  return { head: match?.[1] ?? "", body: match?.[2] ?? text };
}

function allowedBash(head: string): string[] {
  const line =
    head.split("\n").find((l) => l.startsWith("allowed-tools:")) ?? "";
  return [...line.matchAll(/Bash\((.*?)\)(?=,|$)/g)].map((m) => m[1] as string);
}

function bodyInvocations(body: string): string[] {
  const escaped = CLI.replace(/[$.{}"]/g, "\\$&");
  return [...body.matchAll(new RegExp(`${escaped}[^\`\\n]*`, "g"))].map((m) =>
    m[0].trim(),
  );
}

describe("plugin files invoke the CLI through the plugin root", () => {
  const files = pluginFiles();

  test("the scan covers the commands, the skill, and .mcp.json", () => {
    const rel = files.map((f) => relative(ROOT, f));
    expect(rel).toContain(".mcp.json");
    expect(rel).toContain(join("skills", "laptop-triage", "SKILL.md"));
    expect(rel.filter((f) => f.startsWith("commands")).length).toBeGreaterThan(
      0,
    );
  });

  test("no file runs a bare pw-support or allows one", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(
        BARE_INVOCATION.test(text),
        `${relative(ROOT, file)} runs a bare pw-support`,
      ).toBe(false);
      expect(
        BARE_ALLOWED.test(text),
        `${relative(ROOT, file)} allows a bare pw-support`,
      ).toBe(false);
    }
  });

  test("every command that runs the CLI allows exactly the invocation its body uses", () => {
    const commands = files.filter(
      (f) => f.endsWith(".md") && f.includes("/commands/"),
    );
    for (const file of commands) {
      const { head, body } = frontmatter(readFileSync(file, "utf8"));
      const allowed = allowedBash(head);
      const used = bodyInvocations(body);
      const name = relative(ROOT, file);
      for (const entry of allowed) {
        expect(entry.startsWith(CLI), `${name} allows ${entry}`).toBe(true);
      }
      for (const invocation of used) {
        if (!/\b(?:watch|login|logout|token|headers)\b/.test(invocation))
          continue;
        expect(allowed, `${name} does not allow ${invocation}`).toContain(
          invocation,
        );
      }
      if (allowed.length > 0) expect(used.length, name).toBeGreaterThan(0);
    }
  });

  test("the watch command allows start, stop, and status by the same path its body runs", () => {
    const { head, body } = frontmatter(
      readFileSync(join(ROOT, "commands", "watch.md"), "utf8"),
    );
    const allowed = allowedBash(head);
    for (const action of ["start", "stop", "status"]) {
      expect(allowed).toContain(`${CLI} watch ${action}`);
      expect(bodyInvocations(body)).toContain(`${CLI} watch ${action}`);
    }
  });

  test(".mcp.json runs its headers helper through the plugin root", () => {
    const config = JSON.parse(
      readFileSync(join(ROOT, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { headersHelper?: string }>;
    };
    for (const server of Object.values(config.mcpServers)) {
      if (server.headersHelper === undefined) continue;
      expect(server.headersHelper.startsWith(`${CLI} `)).toBe(true);
    }
  });
});

describe("bin/pw-support", () => {
  const bin = join(ROOT, "bin", "pw-support");

  test("exists and is executable", () => {
    expect(statSync(bin).isFile()).toBe(true);
    expect(() => accessSync(bin, constants.X_OK)).not.toThrow();
  });

  test("prints usage from an unrelated working directory with a minimal PATH", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pw-support-bin-"));
    try {
      const child = Bun.spawn([bin, "--help"], {
        cwd,
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: cwd },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(out).toContain("usage: pw-support");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("terminal instructions never use the plugin root variable", () => {
  const README = join(ROOT, "..", "..", "README.md");
  const documents = [...pluginFiles(), README].filter((f) => f.endsWith(".md"));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal plugin variable
  const VARIABLE = "${CLAUDE_PLUGIN_ROOT}";
  const FENCE = "`".repeat(3);

  function terminalBlocks(text: string): string[] {
    const lines = text.split("\n");
    const blocks: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!(lines[i] as string).startsWith(FENCE)) continue;
      let before = i - 1;
      while (before >= 0 && lines[before] === "") before--;
      const end = lines.findIndex((l, j) => j > i && l.startsWith(FENCE));
      if (/terminal/i.test(lines[before] ?? "")) {
        blocks.push(lines.slice(i + 1, end).join("\n"));
      }
      i = end;
    }
    return blocks;
  }

  test("no line that mentions a terminal holds the variable", () => {
    for (const file of documents) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!/terminal/i.test(line)) continue;
        expect(
          line.includes(VARIABLE),
          `${relative(ROOT, file)}: ${line}`,
        ).toBe(false);
      }
    }
  });

  test("terminal blocks use a checkout path, never the variable or a bare name", () => {
    let seen = 0;
    for (const file of documents) {
      for (const block of terminalBlocks(readFileSync(file, "utf8"))) {
        seen += 1;
        expect(block.includes(VARIABLE), block).toBe(false);
        for (const line of block.split("\n")) {
          if (!/pw-support\s+(?:login|logout|token|watch)/.test(line)) continue;
          expect(line.startsWith("modules/plugin/bin/pw-support "), line).toBe(
            true,
          );
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(2);
  });

  test("login and logout run as slash commands through the plugin root", () => {
    for (const name of ["login", "logout"]) {
      const { head, body } = frontmatter(
        readFileSync(join(ROOT, "commands", `${name}.md`), "utf8"),
      );
      expect(allowedBash(head)).toContain(`${CLI} ${name}`);
      expect(bodyInvocations(body)).toContain(`${CLI} ${name}`);
    }
  });

  test("CLI error strings name the running script, not a bare command", async () => {
    const { NotLoggedInError } = await import("./oauth");
    const message = new NotLoggedInError().message;
    expect(message).toContain("run the login command:");
    expect(message).toContain(join(ROOT, "bin", "pw-support"));
    expect(message).not.toContain("run pw-support");
  });
});
