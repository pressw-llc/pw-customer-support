import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTriageSystemPrompt,
  type ContentBlock,
} from "@pw-support/contracts";
import type { PluginConfig } from "./config";
import {
  SUBMIT_ENV,
  SUBMIT_SERVER_NAME,
  SUBMIT_TOOL_FULL_NAME,
  type SubmitOutcome,
} from "./submit-server";

export interface RunInput {
  jobId: string;
  claimToken: string;
  accessToken: string;
  content: ContentBlock[];
}

export interface RunReport {
  toolSetOk: boolean;
  tools: string[] | null;
  mcpServers: { name: string; status: string }[] | null;
  outcome: SubmitOutcome | null;
  timedOut: boolean;
  aborted: boolean;
  exitCode: number | null;
  permissionDenials: number;
  turns: number | null;
  costUsd: number | null;
  digest: Record<string, unknown>[];
}

export interface ClaudeRunner {
  run(input: RunInput, signal?: AbortSignal): Promise<RunReport>;
}

export interface SpawnedProcess {
  stdin: { write(data: string): unknown; end(): unknown };
  stdout: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
}

export type Spawner = (
  command: string[],
  options: SpawnOptions,
) => SpawnedProcess;

export const bunSpawner: Spawner = (command, options) => {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
};

export interface CliRunnerOptions {
  config: PluginConfig;
  cliPath: string;
  spawner?: Spawner;
  scratchRoot?: string;
  timeoutMs?: number;
}

export function buildClaudeArgs(input: {
  mcpConfigPath: string;
  systemPrompt: string;
  model: string | undefined;
  maxBudgetUsd: number;
  maxTurns: number;
}): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    input.mcpConfigPath,
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    SUBMIT_TOOL_FULL_NAME,
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt",
    input.systemPrompt,
    "--max-budget-usd",
    String(input.maxBudgetUsd),
    "--max-turns",
    String(input.maxTurns),
    "--permission-prompts",
    "none",
    ...(input.model ? ["--model", input.model] : []),
  ];
}

const emptyOrMissing = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.length === 0);

export function toolSetIsExact(init: Record<string, unknown>): boolean {
  const tools = init.tools;
  const servers = init.mcp_servers;
  return (
    Array.isArray(tools) &&
    tools.length === 1 &&
    tools[0] === SUBMIT_TOOL_FULL_NAME &&
    Array.isArray(servers) &&
    servers.length === 1 &&
    (servers[0] as { name?: string }).name === SUBMIT_SERVER_NAME &&
    emptyOrMissing(init.skills) &&
    emptyOrMissing(init.slash_commands)
  );
}

function digestOf(event: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = { type: event.type };
  if (event.subtype !== undefined) base.subtype = event.subtype;
  if (event.type === "system" && event.subtype === "init") {
    return {
      ...base,
      tools: event.tools,
      mcp_servers: event.mcp_servers,
      plugins: event.plugins,
      slash_commands: event.slash_commands,
      skills: event.skills,
      agents: event.agents,
      permissionMode: event.permissionMode,
      model: event.model,
    };
  }
  if (event.type === "assistant") {
    const content = (
      event.message as { content?: { type: string; name?: string }[] }
    )?.content;
    return {
      ...base,
      blocks: (content ?? []).map((block) =>
        block.type === "tool_use"
          ? { type: block.type, name: block.name }
          : { type: block.type },
      ),
    };
  }
  if (event.type === "result") {
    return {
      ...base,
      is_error: event.is_error,
      num_turns: event.num_turns,
      total_cost_usd: event.total_cost_usd,
      permission_denials: event.permission_denials,
    };
  }
  return base;
}

export function createClaudeCliRunner(options: CliRunnerOptions): ClaudeRunner {
  const { config } = options;
  const spawner = options.spawner ?? bunSpawner;
  const timeoutMs = options.timeoutMs ?? config.runTimeoutSeconds * 1000;
  return {
    async run(input, signal) {
      const root = mkdtempSync(
        join(options.scratchRoot ?? tmpdir(), "pw-support-run-"),
      );
      chmodSync(root, 0o700);
      const workDir = join(root, "work");
      mkdirSync(workDir);
      const outcomeFile = join(root, "outcome.json");
      const mcpConfigPath = join(root, "mcp.json");
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            [SUBMIT_SERVER_NAME]: {
              type: "stdio",
              command: process.execPath,
              args: [options.cliPath, "submit-server"],
              env: {
                [SUBMIT_ENV.jobId]: input.jobId,
                [SUBMIT_ENV.claimToken]: input.claimToken,
                [SUBMIT_ENV.accessToken]: input.accessToken,
                [SUBMIT_ENV.outcomeFile]: outcomeFile,
                [SUBMIT_ENV.apiUrl]: config.apiUrl,
              },
            },
          },
        }),
        { mode: 0o600 },
      );
      const report: RunReport = {
        toolSetOk: false,
        tools: null,
        mcpServers: null,
        outcome: null,
        timedOut: false,
        aborted: false,
        exitCode: null,
        permissionDenials: 0,
        turns: null,
        costUsd: null,
        digest: [],
      };
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      const proc = spawner(
        [
          config.claudeBin,
          ...buildClaudeArgs({
            mcpConfigPath,
            systemPrompt: buildTriageSystemPrompt("tool"),
            model: config.model,
            maxBudgetUsd: config.maxBudgetUsd,
            maxTurns: config.maxTurns,
          }),
        ],
        { cwd: workDir, env },
      );
      const timer = setTimeout(() => {
        report.timedOut = true;
        proc.kill();
      }, timeoutMs);
      const onAbort = () => {
        report.aborted = true;
        proc.kill();
      };
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort);
      try {
        proc.stdin.write(
          `${JSON.stringify({
            type: "user",
            message: { role: "user", content: input.content },
          })}\n`,
        );
        proc.stdin.end();
        let buffer = "";
        const decoder = new TextDecoder();
        const handle = (line: string) => {
          if (line.trim() === "") return;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return;
          }
          report.digest.push(digestOf(event));
          if (event.type === "system" && event.subtype === "init") {
            report.tools = Array.isArray(event.tools)
              ? (event.tools as string[])
              : null;
            report.mcpServers = Array.isArray(event.mcp_servers)
              ? (event.mcp_servers as { name: string; status: string }[])
              : null;
            report.toolSetOk = toolSetIsExact(event);
            if (!report.toolSetOk) proc.kill();
          } else if (event.type === "result") {
            const denials = event.permission_denials;
            report.permissionDenials = Array.isArray(denials)
              ? denials.length
              : 0;
            report.turns =
              typeof event.num_turns === "number" ? event.num_turns : null;
            report.costUsd =
              typeof event.total_cost_usd === "number"
                ? event.total_cost_usd
                : null;
          }
        };
        for await (const chunk of proc.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            handle(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
          }
        }
        handle(buffer);
        report.exitCode = await proc.exited;
        if (existsSync(outcomeFile)) {
          report.outcome = JSON.parse(
            readFileSync(outcomeFile, "utf8"),
          ) as SubmitOutcome;
        }
        return report;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
