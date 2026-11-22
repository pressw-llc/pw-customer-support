import { describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { buildTriageSystemPrompt } from "@pw-support/contracts";
import { loadPluginConfig } from "./config";
import {
  buildClaudeArgs,
  bunSpawner,
  createClaudeCliRunner,
  type SpawnedProcess,
  type Spawner,
  toolSetIsExact,
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
  plugins: [{ name: "managed-one" }],
};

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
    stdin: string;
    mcpConfig?: Record<string, unknown>;
    mcpMode?: number;
    killed: boolean;
    workEmpty?: boolean;
  } = { command: [], cwd: "", stdin: "", killed: false };
  const spawner: Spawner = (command, options) => {
    seen.command = command;
    seen.cwd = options.cwd;
    seen.workEmpty = readdirSync(options.cwd).length === 0;
    const path = command[command.indexOf("--mcp-config") + 1] as string;
    seen.mcpConfig = JSON.parse(readFileSync(path, "utf8"));
    seen.mcpMode = statSync(path).mode & 0o777;
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
          const server = (
            seen.mcpConfig as {
              mcpServers: Record<string, { env: Record<string, string> }>;
            }
          ).mcpServers.pw_submit;
          writeFileSync(
            server?.env.PW_SUPPORT_OUTCOME_FILE as string,
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

const input = {
  jobId: "11111111-1111-4111-8111-111111111111",
  claimToken: "22222222-2222-4222-8222-222222222222",
  accessToken: "token-abc",
  content: [{ type: "text" as const, text: "CUSTOMER-SECRET-TEXT" }],
};

describe("claude arguments", () => {
  test("disable every built-in tool, load only the strict MCP config, and never prompt", () => {
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
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("m");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
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

  test("accepts only the exact single-tool, single-server init", () => {
    expect(toolSetIsExact(INIT)).toBe(true);
    expect(
      toolSetIsExact({ ...INIT, tools: [SUBMIT_TOOL_FULL_NAME, "Bash"] }),
    ).toBe(false);
    expect(toolSetIsExact({ ...INIT, tools: [] })).toBe(false);
    expect(toolSetIsExact({ ...INIT, tools: undefined })).toBe(false);
    expect(
      toolSetIsExact({
        ...INIT,
        mcp_servers: [
          ...INIT.mcp_servers,
          { name: "other", status: "connected" },
        ],
      }),
    ).toBe(false);
    expect(toolSetIsExact({ ...INIT, mcp_servers: [{ name: "other" }] })).toBe(
      false,
    );
    expect(toolSetIsExact({ ...INIT, skills: ["x"] })).toBe(false);
    expect(toolSetIsExact({ ...INIT, slash_commands: ["x"] })).toBe(false);
    const { skills: _s, slash_commands: _c, ...bare } = INIT;
    expect(toolSetIsExact(bare)).toBe(true);
  });
});

describe("cli runner", () => {
  test("runs in an empty directory with a private config and reads the outcome", async () => {
    const { spawner, seen } = fakeSpawner({
      events: [
        { type: "system", subtype: "hook_started" },
        INIT,
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "CUSTOMER-SECRET-TEXT in model output" },
              {
                type: "tool_use",
                name: SUBMIT_TOOL_FULL_NAME,
                input: { title: "SECRET-TITLE" },
              },
            ],
          },
        },
        "not json",
        {
          type: "result",
          subtype: "success",
          num_turns: 2,
          total_cost_usd: 0.03,
          permission_denials: [],
        },
      ],
      outcome: { accepted: true },
      chunk: 7,
    });
    const runner = createClaudeCliRunner({
      config,
      cliPath: "/cli.ts",
      spawner,
    });
    const report = await runner.run(input);
    expect(report.toolSetOk).toBe(true);
    expect(report.tools).toEqual([SUBMIT_TOOL_FULL_NAME]);
    expect(report.outcome).toEqual({ accepted: true });
    expect(report.turns).toBe(2);
    expect(report.costUsd).toBe(0.03);
    expect(report.permissionDenials).toBe(0);
    expect(report.exitCode).toBe(0);
    expect(seen.workEmpty).toBe(true);
    expect(seen.mcpMode).toBe(0o600);
    expect(seen.command[0]).toBe("claude");
    expect(seen.command[seen.command.indexOf("--system-prompt") + 1]).toBe(
      buildTriageSystemPrompt("tool"),
    );
    const message = JSON.parse(seen.stdin.trim());
    expect(message.message.content).toEqual(input.content);
    const server = (
      seen.mcpConfig as {
        mcpServers: Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        >;
      }
    ).mcpServers.pw_submit;
    expect(server?.args).toEqual(["/cli.ts", "submit-server"]);
    expect(server?.env.PW_SUPPORT_JOB_ID).toBe(input.jobId);
    expect(server?.env.PW_SUPPORT_CLAIM_TOKEN).toBe(input.claimToken);
    expect(JSON.stringify(report.digest)).not.toContain("CUSTOMER-SECRET");
    expect(JSON.stringify(report.digest)).not.toContain("SECRET-TITLE");
    expect(JSON.stringify(report)).not.toContain(input.claimToken);
    expect(JSON.stringify(report)).not.toContain(input.accessToken);
    expect(existsSync(seen.cwd)).toBe(false);
  });

  test("kills the process when the init tool set is not exact", async () => {
    const { spawner, seen } = fakeSpawner({
      hang: true,
      events: [{ ...INIT, tools: [SUBMIT_TOOL_FULL_NAME, "Bash"] }],
    });
    const runner = createClaudeCliRunner({
      config,
      cliPath: "/cli.ts",
      spawner,
    });
    const report = await runner.run(input);
    expect(report.toolSetOk).toBe(false);
    expect(report.outcome).toBeNull();
    expect(seen.killed).toBe(true);
    expect(report.exitCode).toBe(143);
  });

  test("kills the process on timeout and on abort", async () => {
    const slow = fakeSpawner({ hang: true, events: [INIT] });
    const timedOut = await createClaudeCliRunner({
      config,
      cliPath: "/cli.ts",
      spawner: slow.spawner,
      timeoutMs: 40,
    }).run(input);
    expect(timedOut.timedOut).toBe(true);
    expect(slow.seen.killed).toBe(true);

    const aborting = fakeSpawner({ hang: true, events: [INIT] });
    const controller = new AbortController();
    const pending = createClaudeCliRunner({
      config,
      cliPath: "/cli.ts",
      spawner: aborting.spawner,
    }).run(input, controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect((await pending).aborted).toBe(true);

    const before = fakeSpawner({ hang: true, events: [INIT] });
    const early = new AbortController();
    early.abort();
    expect(
      (
        await createClaudeCliRunner({
          config,
          cliPath: "/cli.ts",
          spawner: before.spawner,
        }).run(input, early.signal)
      ).aborted,
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
    const report = await createClaudeCliRunner({
      config,
      cliPath: "/cli.ts",
      spawner,
    }).run(input);
    expect(report.outcome).toBeNull();
    expect(report.permissionDenials).toBe(2);
    expect(report.costUsd).toBeNull();
  });

  test("the default spawner starts a real process and streams its output", async () => {
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
