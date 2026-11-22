import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTriageSystemPrompt } from "@pw-support/contracts";
import { loadPluginConfig } from "./config";
import {
  buildChildEnv,
  buildClaudeArgs,
  bunSpawner,
  CHILD_ENV_NAMES,
  createClaudeCliRunner,
  MANAGED_CONTEXT_NOTE,
  purgeStaleRuns,
  RUN_DIR_PREFIX,
  type RunReport,
  type SpawnedProcess,
  type Spawner,
  StreamGuard,
  staleRunAgeMs,
  toolSetIsExact,
  verifyInit,
} from "./runner";
import { SUBMIT_TOOL_FULL_NAME } from "./submit-server";

const config = loadPluginConfig({ PW_SUPPORT_API_URL: "http://127.0.0.1:1" });
const INIT = {
  type: "system",
  subtype: "init",
  tools: [SUBMIT_TOOL_FULL_NAME],
  mcp_servers: [{ name: "pw_submit", status: "connected" }],
  skills: [],
  slash_commands: [],
  agents: ["general-purpose", "factory:skill-runner"],
  plugins: [{ name: "managed-one" }],
  permissionMode: "dontAsk",
};
const HOOK = {
  type: "system",
  subtype: "hook_started",
  hook_event: "SessionStart",
  hook_name: "SessionStart:startup",
};
const SUBMIT_USE = {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "CUSTOMER-SECRET-TEXT in model output" },
      {
        type: "tool_use",
        id: "tu_1",
        name: SUBMIT_TOOL_FULL_NAME,
        input: { title: "SECRET-TITLE" },
      },
    ],
  },
};
const SUBMIT_RESULT = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "tu_1" }] },
};
const RESULT = {
  type: "result",
  subtype: "success",
  num_turns: 2,
  total_cost_usd: 0.03,
  permission_denials: [],
};

const input = {
  jobId: "11111111-1111-4111-8111-111111111111",
  claimToken: "22222222-2222-4222-8222-222222222222",
  submitToken: "S".repeat(43),
  content: [{ type: "text" as const, text: "CUSTOMER-SECRET-TEXT" }],
};

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pw-support-runner-test-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Script {
  events: (Record<string, unknown> | string)[];
  hang?: boolean;
  outcome?: unknown;
  chunk?: number;
}

function fakeSpawner(script: Script) {
  const seen: {
    command: string[];
    cwd: string;
    env: Record<string, string>;
    stdin: string;
    mcpConfig?: {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    submitConfig?: Record<string, string>;
    mcpMode?: number;
    killed: boolean;
    workEmpty?: boolean;
  } = { command: [], cwd: "", env: {}, stdin: "", killed: false };
  const spawner: Spawner = (command, options) => {
    seen.command = command;
    seen.cwd = options.cwd;
    seen.env = options.env;
    seen.workEmpty = readdirSync(options.cwd).length === 0;
    const path = command[command.indexOf("--mcp-config") + 1] as string;
    seen.mcpConfig = JSON.parse(readFileSync(path, "utf8"));
    seen.mcpMode = statSync(path).mode & 0o777;
    const server = seen.mcpConfig?.mcpServers.pw_submit;
    seen.submitConfig = JSON.parse(
      readFileSync(server?.args[2] as string, "utf8"),
    );
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const text = script.events
      .map((event) =>
        typeof event === "string" ? event : JSON.stringify(event),
      )
      .join("\n");
    const proc: SpawnedProcess = {
      stdin: {
        write(data) {
          seen.stdin += data;
        },
        end() {},
      },
      stdout: (async function* () {
        const bytes = new TextEncoder().encode(`${text}\n`);
        const size = script.chunk ?? bytes.length;
        for (let offset = 0; offset < bytes.length; offset += size) {
          yield bytes.slice(offset, offset + size);
        }
        if (script.hang) await released;
        if (script.outcome !== undefined) {
          writeFileSync(
            seen.submitConfig?.outcomeFile as string,
            JSON.stringify(script.outcome),
          );
        }
      })(),
      exited: released.then(() => (seen.killed ? 143 : 0)),
      kill() {
        seen.killed = true;
        release();
      },
    };
    if (!script.hang) release();
    return proc;
  };
  return { spawner, seen };
}

function runner(spawner: Spawner, extra: object = {}) {
  return createClaudeCliRunner({
    config,
    cliPath: "/cli.ts",
    spawner,
    scratchRoot: scratch,
    ...extra,
  });
}

describe("claude arguments", () => {
  test("disable every built-in tool, load only the strict MCP config, include hook events, and never prompt", () => {
    const args = buildClaudeArgs({
      mcpConfigPath: "/tmp/mcp.json",
      systemPrompt: "prompt",
      model: "m",
      maxBudgetUsd: 0.5,
      maxTurns: 3,
    });
    expect(args).toContain("-p");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      SUBMIT_TOOL_FULL_NAME,
    );
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("3");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--include-hook-events");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("m");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args.join(" ")).not.toContain("token");
    expect(
      buildClaudeArgs({
        mcpConfigPath: "/x",
        systemPrompt: "p",
        model: undefined,
        maxBudgetUsd: 1,
        maxTurns: 2,
      }),
    ).not.toContain("--model");
  });
});

describe("init verification", () => {
  test("accepts the exact single-tool, single-server init and records counts", () => {
    const verified = verifyInit(INIT);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.facts).toEqual({
        toolNames: [SUBMIT_TOOL_FULL_NAME],
        mcpServers: [{ name: "pw_submit", status: "connected" }],
        pluginCount: 1,
        skillCount: 0,
        slashCommandCount: 0,
        agentCount: 2,
        permissionMode: "dontAsk",
      });
    }
    expect(toolSetIsExact(INIT)).toBe(true);
  });

  test.each([
    ["extra tool", { tools: [SUBMIT_TOOL_FULL_NAME, "Bash"] }, "tools"],
    ["no tool", { tools: [] }, "tools"],
    ["missing tools", { tools: undefined }, "init_field_missing"],
    [
      "second server",
      {
        mcp_servers: [
          { name: "pw_submit", status: "connected" },
          { name: "other", status: "connected" },
        ],
      },
      "mcp_servers",
    ],
    [
      "foreign server",
      { mcp_servers: [{ name: "other", status: "connected" }] },
      "mcp_servers",
    ],
    [
      "server not connected",
      { mcp_servers: [{ name: "pw_submit", status: "failed" }] },
      "mcp_status",
    ],
    ["skills", { skills: ["x"] }, "skills"],
    ["slash commands", { slash_commands: ["x"] }, "slash_commands"],
    ["missing skills", { skills: undefined }, "init_field_missing"],
    ["missing commands", { slash_commands: undefined }, "init_field_missing"],
    ["missing agents", { agents: undefined }, "init_field_missing"],
    ["missing plugins", { plugins: undefined }, "init_field_missing"],
    ["permission mode", { permissionMode: "default" }, "permission_mode"],
  ])("rejects %s", (_name, patch, reason) => {
    const result = verifyInit({ ...INIT, ...patch });
    expect(result).toEqual({ ok: false, reason });
    expect(toolSetIsExact({ ...INIT, ...patch })).toBe(false);
  });
});

describe("stream guard", () => {
  const guarded = () => {
    const guard = new StreamGuard();
    guard.handle(INIT);
    return guard;
  };

  test("a submit tool use, its result, and SessionStart hooks pass", () => {
    const guard = guarded();
    expect(guard.handle(HOOK).kill).toBe(false);
    expect(guard.handle({ ...HOOK, subtype: "hook_response" }).kill).toBe(
      false,
    );
    expect(guard.handle(SUBMIT_USE).kill).toBe(false);
    expect(guard.handle(SUBMIT_RESULT).kill).toBe(false);
    expect(guard.violation).toBeNull();
    expect([...guard.hookEvents]).toEqual(["SessionStart"]);
  });

  test.each([
    [
      "a foreign tool use",
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "x", name: "Bash" }] },
      },
      "foreign_tool_use",
    ],
    [
      "a foreign tool use after the submit tool",
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "a", name: SUBMIT_TOOL_FULL_NAME },
            { type: "tool_use", id: "b", name: "mcp__other__tool" },
          ],
        },
      },
      "foreign_tool_use",
    ],
    [
      "a tool result for an unknown call",
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "never-seen" }],
        },
      },
      "foreign_tool_result",
    ],
    [
      "a tool result without an id",
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      "foreign_tool_result",
    ],
    [
      "a PreToolUse hook",
      { ...HOOK, hook_event: "PreToolUse" },
      "foreign_hook",
    ],
    [
      "a hook response for another event",
      { ...HOOK, subtype: "hook_response", hook_event: "UserPromptSubmit" },
      "foreign_hook",
    ],
    [
      "a hook event the guard cannot read",
      { type: "system", subtype: "hook_started" },
      "foreign_hook",
    ],
  ])("kills on %s", (_name, event, kind) => {
    const guard = guarded();
    expect(guard.handle(event as Record<string, unknown>).kill).toBe(true);
    expect(guard.violation?.kind as string).toBe(kind);
    expect(guard.handle(SUBMIT_USE).kill).toBe(true);
  });

  test("a tool result for a foreign tool is rejected even when its use was refused earlier", () => {
    const guard = guarded();
    guard.handle({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "x", name: "Read" }] },
    });
    expect(guard.violation?.kind).toBe("foreign_tool_use");
    expect(
      guard.handle({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "x" }] },
      }).kill,
    ).toBe(true);
    expect(guard.violation?.kind).toBe("foreign_tool_use");
  });

  test("a bad init is a violation and sanitizes names", () => {
    const guard = new StreamGuard();
    expect(guard.handle({ ...INIT, tools: ["Bash"] })).toEqual({
      kill: true,
      initVerified: false,
    });
    expect(guard.violation).toEqual({
      kind: "init_unverified",
      detail: "tools",
    });
    const named = new StreamGuard();
    named.handle(INIT);
    named.handle({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "z", name: "rm -rf /; CUSTOMER SECRET" },
        ],
      },
    });
    expect(named.violation?.detail).toBe("rm_-rf____CUSTOMER_SECRET");
  });
});

describe("child environment", () => {
  test("keeps only the named variables and LC_ locale values", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      LC_ALL: "C",
      LANG: "C",
      ANTHROPIC_API_KEY: "claude-key",
      HTTPS_PROXY: "http://proxy",
      TYPESAFE_API_KEY: "jev-key",
      GITHUB_TOKEN: "gh",
      PW_SUPPORT_ACCESS_TOKEN: "tok",
      AWS_SECRET_ACCESS_KEY: "aws",
      EMPTY: "",
      ALSO_EMPTY_ALLOWED: undefined,
    });
    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "HOME",
      "HTTPS_PROXY",
      "LANG",
      "LC_ALL",
      "PATH",
    ]);
    expect(CHILD_ENV_NAMES).not.toContain("TYPESAFE_API_KEY" as never);
    expect(CHILD_ENV_NAMES).not.toContain("AWS_SECRET_ACCESS_KEY" as never);
  });
});

describe("cli runner", () => {
  test("runs in an empty directory, primes before the request, and reads the outcome", async () => {
    const { spawner, seen } = fakeSpawner({
      events: [HOOK, INIT, SUBMIT_USE, "not json", SUBMIT_RESULT, RESULT],
      outcome: { accepted: true },
      chunk: 7,
    });
    const report = await runner(spawner, {
      source: {
        PATH: "/usr/bin",
        HOME: "/h",
        TYPESAFE_API_KEY: "jev-secret",
        ANTHROPIC_API_KEY: "claude-key",
      },
    }).run(input);
    expect(report.toolSetOk).toBe(true);
    expect(report.tools).toEqual([SUBMIT_TOOL_FULL_NAME]);
    expect(report.init?.agentCount).toBe(2);
    expect(report.hookEvents).toEqual(["SessionStart"]);
    expect(report.violation).toBeNull();
    expect(report.managedContext).toBe(MANAGED_CONTEXT_NOTE);
    expect(report.outcome).toEqual({ accepted: true });
    expect(report.turns).toBe(2);
    expect(report.costUsd).toBe(0.03);
    expect(report.permissionDenials).toBe(0);
    expect(report.exitCode).toBe(0);
    expect(report.childEnvKeys).toEqual(["ANTHROPIC_API_KEY", "HOME", "PATH"]);
    expect(Object.keys(seen.env).sort()).toEqual(report.childEnvKeys);
    expect(seen.workEmpty).toBe(true);
    expect(seen.mcpMode).toBe(0o600);
    expect(seen.command[0]).toBe("claude");
    expect(seen.command[seen.command.indexOf("--system-prompt") + 1]).toBe(
      buildTriageSystemPrompt("tool"),
    );
    const [primer, request] = seen.stdin
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(JSON.stringify(primer)).not.toContain("CUSTOMER");
    expect(request.message.content).toEqual(input.content);
    const server = seen.mcpConfig?.mcpServers.pw_submit;
    expect(server?.args.slice(0, 2)).toEqual(["/cli.ts", "submit-server"]);
    expect(JSON.stringify(seen.mcpConfig)).not.toContain(input.submitToken);
    expect(JSON.stringify(seen.command)).not.toContain(input.submitToken);
    expect(JSON.stringify(seen.command)).not.toContain(input.claimToken);
    expect(JSON.stringify(seen.env)).not.toContain(input.submitToken);
    expect(seen.submitConfig).toEqual({
      jobId: input.jobId,
      claimToken: input.claimToken,
      submitToken: input.submitToken,
      apiUrl: "http://127.0.0.1:1",
      outcomeFile: seen.submitConfig?.outcomeFile as string,
    });
    expect(JSON.stringify(report.digest)).not.toContain("CUSTOMER-SECRET");
    expect(JSON.stringify(report.digest)).not.toContain("SECRET-TITLE");
    expect(JSON.stringify(report)).not.toContain(input.claimToken);
    expect(JSON.stringify(report)).not.toContain(input.submitToken);
    expect(existsSync(seen.cwd)).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("never writes the request when the init is not verified", async () => {
    const { spawner, seen } = fakeSpawner({
      hang: true,
      events: [HOOK, { ...INIT, tools: [SUBMIT_TOOL_FULL_NAME, "Bash"] }],
    });
    const report = await runner(spawner).run(input);
    expect(report.toolSetOk).toBe(false);
    expect(report.violation?.kind).toBe("init_unverified");
    expect(report.outcome).toBeNull();
    expect(seen.killed).toBe(true);
    expect(report.exitCode).toBe(143);
    expect(seen.stdin).not.toContain("CUSTOMER-SECRET-TEXT");
    expect(seen.stdin.trim().split("\n")).toHaveLength(1);
  });

  test("kills when no init arrives in time", async () => {
    const { spawner, seen } = fakeSpawner({ hang: true, events: [HOOK] });
    const report = await runner(spawner, { initTimeoutMs: 30 }).run(input);
    expect(report.violation?.kind).toBe("init_timeout");
    expect(seen.killed).toBe(true);
    expect(seen.stdin).not.toContain("CUSTOMER-SECRET-TEXT");
  });

  test("kills the process on timeout and on abort", async () => {
    const slow = fakeSpawner({ hang: true, events: [INIT] });
    const timedOut = await runner(slow.spawner, { timeoutMs: 40 }).run(input);
    expect(timedOut.timedOut).toBe(true);
    expect(slow.seen.killed).toBe(true);

    const aborting = fakeSpawner({ hang: true, events: [INIT] });
    const controller = new AbortController();
    const pending = runner(aborting.spawner).run(input, controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect((await pending).aborted).toBe(true);

    const before = fakeSpawner({ hang: true, events: [INIT] });
    const early = new AbortController();
    early.abort();
    expect(
      (await runner(before.spawner).run(input, early.signal)).aborted,
    ).toBe(true);
  });

  test("reports no outcome when the subagent never submits", async () => {
    const { spawner } = fakeSpawner({
      events: [
        INIT,
        {
          type: "result",
          subtype: "success",
          num_turns: 1,
          permission_denials: [{}, {}],
        },
      ],
    });
    const report = await runner(spawner).run(input);
    expect(report.outcome).toBeNull();
    expect(report.permissionDenials).toBe(2);
    expect(report.costUsd).toBeNull();
  });

  test("deletes the run directory when the spawn fails and on a signal", async () => {
    const failing: Spawner = () => {
      throw new Error("spawn failed");
    };
    await expect(runner(failing).run(input)).rejects.toThrow("spawn failed");
    expect(readdirSync(scratch)).toEqual([]);

    const hanging = fakeSpawner({ hang: true, events: [INIT] });
    const before = process.listeners("SIGTERM").length;
    const pending = runner(hanging.spawner).run(input);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readdirSync(scratch)).toHaveLength(1);
    const listeners = process.listeners("SIGTERM");
    expect(listeners.length).toBe(before + 1);
    (listeners.at(-1) as () => void)();
    expect(readdirSync(scratch)).toEqual([]);
    expect(hanging.seen.killed).toBe(true);
    expect((await pending).aborted).toBe(true);
    expect(process.listeners("SIGTERM").length).toBe(before);
  });
});

describe("stale run directories", () => {
  test("purges only old run directories under the scratch root", () => {
    const old = join(scratch, `${RUN_DIR_PREFIX}old`);
    const fresh = join(scratch, `${RUN_DIR_PREFIX}fresh`);
    const other = join(scratch, "unrelated");
    for (const dir of [old, fresh, other]) mkdirSync(dir);
    const past = new Date(Date.now() - 10 * 60_000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(purgeStaleRuns(scratch, staleRunAgeMs(90_000))).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(purgeStaleRuns(join(scratch, "missing"), 1)).toBe(0);
  });
});

describe("fake claude binary", () => {
  interface Scenario {
    afterPrimer: Record<string, unknown>[];
    afterRequest: Record<string, unknown>[];
    hang?: boolean;
  }

  function fakeClaude(scenario: Scenario) {
    const log = join(scratch, "fake.log");
    const script = join(scratch, "fake-claude.ts");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
const scenario = ${JSON.stringify(scenario)};
const log = ${JSON.stringify(log)};
appendFileSync(log, JSON.stringify({ env: Object.keys(process.env).sort() }) + "\\n");
const emit = (event) => console.log(JSON.stringify(event));
emit(${JSON.stringify(HOOK)});
let lines = 0;
let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\\n");
    lines += 1;
    appendFileSync(log, JSON.stringify({ stdin: lines, text: line }) + "\\n");
    for (const event of lines === 1 ? scenario.afterPrimer : scenario.afterRequest) emit(event);
  }
});
process.stdin.on("end", () => { if (!scenario.hang) setTimeout(() => process.exit(0), 20); });
if (scenario.hang) setInterval(() => {}, 1000);
`,
    );
    const bin = join(scratch, "claude");
    writeFileSync(
      bin,
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    );
    chmodSync(bin, 0o755);
    const lines = () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    return { bin, lines };
  }

  const real = (bin: string) =>
    createClaudeCliRunner({
      config: { ...config, claudeBin: bin },
      cliPath: "/cli.ts",
      scratchRoot: scratch,
      timeoutMs: 10_000,
      initTimeoutMs: 3000,
      source: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TYPESAFE_API_KEY: "jev-secret",
        GITHUB_TOKEN: "gh-secret",
      },
    });

  const run = async (
    scenario: Scenario,
  ): Promise<{
    report: RunReport;
    lines: () => Record<string, unknown>[];
  }> => {
    const fake = fakeClaude(scenario);
    const report = await real(fake.bin).run(input);
    return { report, lines: fake.lines };
  };

  const stdinLines = (lines: () => Record<string, unknown>[]) =>
    lines().filter((entry) => "stdin" in entry);

  test("a clean session sends the primer, then the request after init, and the child env holds no secret", async () => {
    const { report, lines } = await run({
      afterPrimer: [INIT],
      afterRequest: [SUBMIT_USE, SUBMIT_RESULT, RESULT],
    });
    expect(report.violation).toBeNull();
    expect(report.toolSetOk).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(stdinLines(lines)).toHaveLength(2);
    const env = lines()[0]?.env as string[];
    expect(env).toContain("PATH");
    expect(env).not.toContain("TYPESAFE_API_KEY");
    expect(env).not.toContain("GITHUB_TOKEN");
    expect(report.childEnvKeys).toEqual(["HOME", "PATH"]);
  });

  test.each([
    ["extra tool", { ...INIT, tools: [SUBMIT_TOOL_FULL_NAME, "Read"] }],
    [
      "foreign server",
      { ...INIT, mcp_servers: [{ name: "x", status: "connected" }] },
    ],
    ["skills present", { ...INIT, skills: ["s"] }],
    ["missing agents field", { ...INIT, agents: undefined }],
  ])("withholds the request on a bad init: %s", async (_name, init) => {
    const { report, lines } = await run({
      hang: true,
      afterPrimer: [init as Record<string, unknown>],
      afterRequest: [],
    });
    expect(report.violation?.kind).toBe("init_unverified");
    expect(report.exitCode).not.toBe(0);
    const sent = stdinLines(lines);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("CUSTOMER-SECRET-TEXT");
  });

  test.each([
    [
      "a foreign tool use",
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t", name: "Bash" }] },
      },
      "foreign_tool_use",
    ],
    [
      "a foreign tool result",
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t" }] },
      },
      "foreign_tool_result",
    ],
    [
      "a hook other than SessionStart",
      { ...HOOK, hook_event: "PostToolUse" },
      "foreign_hook",
    ],
  ])("kills the child on %s", async (_name, event, kind) => {
    const { report } = await run({
      hang: true,
      afterPrimer: [INIT],
      afterRequest: [event],
    });
    expect(report.violation?.kind as string).toBe(kind);
    expect(report.outcome).toBeNull();
    expect(report.exitCode).not.toBe(0);
    expect(report.toolSetOk).toBe(true);
  });

  test("kills the child when init never arrives", async () => {
    const fake = fakeClaude({ hang: true, afterPrimer: [], afterRequest: [] });
    const report = await createClaudeCliRunner({
      config: { ...config, claudeBin: fake.bin },
      cliPath: "/cli.ts",
      scratchRoot: scratch,
      initTimeoutMs: 1200,
      source: { PATH: process.env.PATH },
    }).run(input);
    expect(report.violation?.kind).toBe("init_timeout");
    expect(report.exitCode).not.toBe(0);
    expect(stdinLines(fake.lines).length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(fake.lines())).not.toContain("CUSTOMER-SECRET-TEXT");
  });
});

describe("default spawner", () => {
  test("starts a real process and streams its output", async () => {
    const proc = bunSpawner(["/bin/sh", "-c", "cat"], {
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
    });
    proc.stdin.write("hello\n");
    proc.stdin.end();
    let out = "";
    for await (const chunk of proc.stdout)
      out += new TextDecoder().decode(chunk);
    expect(out).toBe("hello\n");
    expect(await proc.exited).toBe(0);
    const sleeper = bunSpawner(["/bin/sh", "-c", "sleep 30"], {
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "" },
    });
    sleeper.kill();
    expect(await sleeper.exited).not.toBe(0);
  });
});
