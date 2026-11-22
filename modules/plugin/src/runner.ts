import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
  SUBMIT_SERVER_NAME,
  SUBMIT_TOOL_FULL_NAME,
  type SubmitConfig,
  type SubmitOutcome,
} from "./submit-server";

export const RUN_DIR_PREFIX = "pw-support-run-";
export const MANAGED_CONTEXT_NOTE =
  "organization-managed CLAUDE.md and SessionStart output can enter the headless context and no flag disables them";

const SESSION_START = "SessionStart";
const MAX_NAME_CHARS = 80;
const DEFAULT_INIT_TIMEOUT_MS = 20_000;
const STALE_RUN_MARGIN_MS = 60_000;

const PRIMER_TEXT =
  "Session check. Reply with the single word ready and call no tool. The request arrives in the next message.";

export const CHILD_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "TZ",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const CHILD_ENV_PREFIXES = ["LC_"] as const;

export function buildChildEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || value === "") continue;
    const allowed =
      (CHILD_ENV_NAMES as readonly string[]).includes(name) ||
      CHILD_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (allowed) env[name] = value;
  }
  return env;
}

export interface RunInput {
  jobId: string;
  claimToken: string;
  submitToken: string;
  content: ContentBlock[];
}

export interface InitFacts {
  toolNames: string[];
  mcpServers: { name: string; status: string }[];
  pluginCount: number;
  skillCount: number;
  slashCommandCount: number;
  agentCount: number;
  permissionMode: string | null;
}

export type ViolationKind =
  | "init_unverified"
  | "init_timeout"
  | "foreign_tool_use"
  | "foreign_tool_result"
  | "foreign_hook";

export interface Violation {
  kind: ViolationKind;
  detail: string;
}

export interface RunReport {
  toolSetOk: boolean;
  init: InitFacts | null;
  hookEvents: string[];
  violation: Violation | null;
  childEnvKeys: string[];
  managedContext: string;
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
  initTimeoutMs?: number;
  source?: Record<string, string | undefined>;
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
    "--include-hook-events",
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

const safeName = (value: unknown): string =>
  typeof value === "string"
    ? value.replace(/[^\w:.-]/g, "_").slice(0, MAX_NAME_CHARS)
    : "unknown";

const listOf = (value: unknown): unknown[] | null =>
  Array.isArray(value) ? value : null;

export function verifyInit(
  init: Record<string, unknown>,
): { ok: true; facts: InitFacts } | { ok: false; reason: string } {
  const tools = listOf(init.tools);
  const servers = listOf(init.mcp_servers);
  const skills = listOf(init.skills);
  const commands = listOf(init.slash_commands);
  const agents = listOf(init.agents);
  const plugins = listOf(init.plugins);
  if (!tools || !servers || !skills || !commands || !agents || !plugins) {
    return { ok: false, reason: "init_field_missing" };
  }
  if (tools.length !== 1 || tools[0] !== SUBMIT_TOOL_FULL_NAME) {
    return { ok: false, reason: "tools" };
  }
  const server = servers[0] as { name?: unknown; status?: unknown } | undefined;
  if (servers.length !== 1 || server?.name !== SUBMIT_SERVER_NAME) {
    return { ok: false, reason: "mcp_servers" };
  }
  if (server.status !== "connected") return { ok: false, reason: "mcp_status" };
  if (skills.length > 0) return { ok: false, reason: "skills" };
  if (commands.length > 0) return { ok: false, reason: "slash_commands" };
  if (init.permissionMode !== "dontAsk") {
    return { ok: false, reason: "permission_mode" };
  }
  return {
    ok: true,
    facts: {
      toolNames: tools.map(safeName),
      mcpServers: [{ name: SUBMIT_SERVER_NAME, status: "connected" }],
      pluginCount: plugins.length,
      skillCount: skills.length,
      slashCommandCount: commands.length,
      agentCount: agents.length,
      permissionMode: "dontAsk",
    },
  };
}

export const toolSetIsExact = (init: Record<string, unknown>): boolean =>
  verifyInit(init).ok;

interface Block {
  type?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
}

const blocksOf = (event: Record<string, unknown>): Block[] => {
  const content = (event.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

export interface GuardStep {
  kill: boolean;
  initVerified: boolean;
}

export class StreamGuard {
  init: InitFacts | null = null;
  violation: Violation | null = null;
  readonly hookEvents = new Set<string>();
  private readonly toolNames = new Map<string, string>();

  private fail(kind: ViolationKind, detail: string): GuardStep {
    if (!this.violation) this.violation = { kind, detail: safeName(detail) };
    return { kill: true, initVerified: false };
  }

  handle(event: Record<string, unknown>): GuardStep {
    const none: GuardStep = { kill: false, initVerified: false };
    if (this.violation) return { kill: true, initVerified: false };
    if (event.type === "system" && event.subtype === "init") {
      const verified = verifyInit(event);
      if (!verified.ok) return this.fail("init_unverified", verified.reason);
      this.init = verified.facts;
      return { kill: false, initVerified: true };
    }
    if (
      event.type === "system" &&
      typeof event.subtype === "string" &&
      event.subtype.startsWith("hook_")
    ) {
      const name = event.hook_event;
      if (typeof name !== "string") return this.fail("foreign_hook", "unknown");
      this.hookEvents.add(safeName(name));
      if (name !== SESSION_START) return this.fail("foreign_hook", name);
      return none;
    }
    if (event.type === "assistant") {
      for (const block of blocksOf(event)) {
        if (block.type !== "tool_use") continue;
        if (block.name !== SUBMIT_TOOL_FULL_NAME) {
          return this.fail("foreign_tool_use", block.name ?? "unknown");
        }
        if (block.id) this.toolNames.set(block.id, block.name);
      }
      return none;
    }
    if (event.type === "user") {
      for (const block of blocksOf(event)) {
        if (block.type !== "tool_result") continue;
        const name = block.tool_use_id
          ? this.toolNames.get(block.tool_use_id)
          : undefined;
        if (name !== SUBMIT_TOOL_FULL_NAME) {
          return this.fail("foreign_tool_result", name ?? "unknown");
        }
      }
    }
    return none;
  }
}

function digestOf(event: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = { type: event.type };
  if (event.subtype !== undefined) base.subtype = safeName(event.subtype);
  if (event.type === "system" && event.subtype === "init") {
    return {
      ...base,
      tools: listOf(event.tools)?.map(safeName),
      mcp_servers: listOf(event.mcp_servers),
      pluginCount: listOf(event.plugins)?.length,
      skillCount: listOf(event.skills)?.length,
      slashCommandCount: listOf(event.slash_commands)?.length,
      agentCount: listOf(event.agents)?.length,
      permissionMode: event.permissionMode,
    };
  }
  if (event.type === "system" && typeof event.hook_event === "string") {
    return { ...base, hook_event: safeName(event.hook_event) };
  }
  if (event.type === "assistant") {
    return {
      ...base,
      blocks: blocksOf(event).map((block) =>
        block.type === "tool_use"
          ? { type: block.type, name: safeName(block.name) }
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
      permission_denials: Array.isArray(event.permission_denials)
        ? event.permission_denials.length
        : 0,
    };
  }
  return base;
}

const userMessage = (content: unknown) =>
  `${JSON.stringify({
    type: "user",
    message: { role: "user", content },
  })}\n`;

export function purgeStaleRuns(
  scratchRoot: string,
  maxAgeMs: number,
  now: number = Date.now(),
): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(scratchRoot);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(RUN_DIR_PREFIX)) continue;
    const path = join(scratchRoot, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) {
        rmSync(path, { recursive: true, force: true });
        removed += 1;
      }
    } catch {}
  }
  return removed;
}

export function staleRunAgeMs(runTimeoutMs: number): number {
  return runTimeoutMs + STALE_RUN_MARGIN_MS;
}

export function createClaudeCliRunner(options: CliRunnerOptions): ClaudeRunner {
  const { config } = options;
  const spawner = options.spawner ?? bunSpawner;
  const timeoutMs = options.timeoutMs ?? config.runTimeoutSeconds * 1000;
  const initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  return {
    async run(input, signal) {
      const root = mkdtempSync(
        join(options.scratchRoot ?? tmpdir(), RUN_DIR_PREFIX),
      );
      chmodSync(root, 0o700);
      const report: RunReport = {
        toolSetOk: false,
        init: null,
        hookEvents: [],
        violation: null,
        childEnvKeys: [],
        managedContext: MANAGED_CONTEXT_NOTE,
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
      let proc: SpawnedProcess | undefined;
      const onSignal = () => {
        report.aborted = true;
        proc?.kill();
        rmSync(root, { recursive: true, force: true });
      };
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let initTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        report.aborted = true;
        proc?.kill();
      };
      try {
        const workDir = join(root, "work");
        mkdirSync(workDir);
        const outcomeFile = join(root, "outcome.json");
        const submitConfigPath = join(root, "submit.json");
        const submitConfig: SubmitConfig = {
          jobId: input.jobId,
          claimToken: input.claimToken,
          submitToken: input.submitToken,
          apiUrl: config.apiUrl,
          outcomeFile,
        };
        writeFileSync(submitConfigPath, JSON.stringify(submitConfig), {
          mode: 0o600,
        });
        const mcpConfigPath = join(root, "mcp.json");
        writeFileSync(
          mcpConfigPath,
          JSON.stringify({
            mcpServers: {
              [SUBMIT_SERVER_NAME]: {
                type: "stdio",
                command: process.execPath,
                args: [options.cliPath, "submit-server", submitConfigPath],
              },
            },
          }),
          { mode: 0o600 },
        );
        const env = buildChildEnv(options.source ?? process.env);
        report.childEnvKeys = Object.keys(env).sort();
        const child = spawner(
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
        proc = child;
        timer = setTimeout(() => {
          report.timedOut = true;
          child.kill();
        }, timeoutMs);
        initTimer = setTimeout(() => {
          if (report.init) return;
          report.violation ??= { kind: "init_timeout", detail: "no_init" };
          child.kill();
        }, initTimeoutMs);
        if (signal?.aborted) onAbort();
        signal?.addEventListener("abort", onAbort);

        const guard = new StreamGuard();
        const send = (data: string, end = false) => {
          try {
            child.stdin.write(data);
            if (end) child.stdin.end();
          } catch {}
        };
        send(userMessage([{ type: "text", text: PRIMER_TEXT }]));
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
          const step = guard.handle(event);
          report.init = guard.init;
          report.hookEvents = [...guard.hookEvents].sort();
          report.violation = guard.violation ?? report.violation;
          if (event.type === "system" && event.subtype === "init") {
            report.tools = listOf(event.tools)?.map(safeName) ?? null;
            report.mcpServers = guard.init?.mcpServers ?? null;
            report.toolSetOk = step.initVerified;
          }
          if (step.kill) {
            child.kill();
            return;
          }
          if (step.initVerified) {
            send(userMessage(input.content), true);
            return;
          }
          if (event.type === "result") {
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
        for await (const chunk of child.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            handle(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
          }
        }
        handle(buffer);
        report.exitCode = await child.exited;
        if (existsSync(outcomeFile)) {
          report.outcome = JSON.parse(
            readFileSync(outcomeFile, "utf8"),
          ) as SubmitOutcome;
        }
        return report;
      } finally {
        clearTimeout(timer);
        clearTimeout(initTimer);
        signal?.removeEventListener("abort", onAbort);
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
