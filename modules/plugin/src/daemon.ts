import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LogDetail } from "./watcher";

export interface DaemonPaths {
  dir: string;
  pidFile: string;
  logFile: string;
}

export function daemonPaths(configDir: string): DaemonPaths {
  const dir = join(configDir, "watch");
  return {
    dir,
    pidFile: join(dir, "watcher.pid"),
    logFile: join(dir, "watcher.log"),
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface PidRecord {
  pid: number;
  nonce: string;
}

export interface DaemonDeps {
  commandLine?: (pid: number) => string | null;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export function commandLineOf(pid: number): string | null {
  try {
    const line = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

export function readPidRecord(paths: DaemonPaths): PidRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(paths.pidFile, "utf8")) as {
      pid?: unknown;
      nonce?: unknown;
    };
    return Number.isInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.nonce === "string" &&
      parsed.nonce.length >= 16
      ? { pid: parsed.pid as number, nonce: parsed.nonce }
      : null;
  } catch {
    return null;
  }
}

export function readPid(paths: DaemonPaths): number | null {
  return readPidRecord(paths)?.pid ?? null;
}

function isOurWatcher(record: PidRecord, deps: DaemonDeps): boolean {
  if (!isAlive(record.pid)) return false;
  const line = (deps.commandLine ?? commandLineOf)(record.pid);
  return Boolean(
    line?.includes("watch run") && line.includes(`--nonce ${record.nonce}`),
  );
}

export function runningPid(
  paths: DaemonPaths,
  deps: DaemonDeps = {},
): number | null {
  const record = readPidRecord(paths);
  if (record && isOurWatcher(record, deps)) return record.pid;
  rmSync(paths.pidFile, { force: true });
  return null;
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function writePid(paths: DaemonPaths, pid: number, nonce: string): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.pidFile, JSON.stringify({ pid, nonce }), { mode: 0o600 });
}

export function clearPid(paths: DaemonPaths, pid: number): void {
  if (readPid(paths) === pid) rmSync(paths.pidFile, { force: true });
}

export function pruneReports(dir: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((name) => name.startsWith("run-") && name.endsWith(".json"))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const file of files.slice(keep)) rmSync(join(dir, file.name));
}

export function createFileLogger(
  path: string,
  now: () => Date = () => new Date(),
): (event: string, detail?: LogDetail) => void {
  return (event, detail) => {
    const line = `${now().toISOString()} ${event}${
      detail ? ` ${JSON.stringify(detail)}` : ""
    }\n`;
    try {
      appendFileSync(path, line, { mode: 0o600 });
    } catch {}
  };
}

export type StartResult =
  | { started: true; pid: number }
  | { started: false; pid: number };

export async function startDaemon(input: {
  paths: DaemonPaths;
  command: string[];
  env: Record<string, string>;
  settleMs?: number;
  deps?: DaemonDeps;
}): Promise<StartResult> {
  const existing = runningPid(input.paths, input.deps);
  if (existing !== null) return { started: false, pid: existing };
  mkdirSync(input.paths.dir, { recursive: true, mode: 0o700 });
  const fd = openSync(input.paths.logFile, "a", 0o600);
  try {
    const nonce = newNonce();
    const [bin = "", ...rest] = input.command;
    const args = [...rest, "--nonce", nonce];
    const child = spawn(bin, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: input.env,
    });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error("the watcher failed to start");
    writePid(input.paths, pid, nonce);
    await new Promise((resolve) => setTimeout(resolve, input.settleMs ?? 300));
    if (!isAlive(pid)) {
      rmSync(input.paths.pidFile, { force: true });
      throw new Error("the watcher exited at startup; see the log file");
    }
    return { started: true, pid };
  } finally {
    closeSync(fd);
  }
}

export type StopResult = "not_running" | "stopped" | "killed";

export async function stopDaemon(
  paths: DaemonPaths,
  options: { timeoutMs?: number; deps?: DaemonDeps } = {},
): Promise<StopResult> {
  const pid = runningPid(paths, options.deps);
  if (pid === null) return "not_running";
  const kill = options.deps?.kill ?? process.kill.bind(process);
  kill(pid, "SIGTERM");
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let result: StopResult = "stopped";
  if (isAlive(pid)) {
    kill(pid, "SIGKILL");
    result = "killed";
    const killDeadline = Date.now() + 2000;
    while (isAlive(pid) && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  rmSync(paths.pidFile, { force: true });
  return result;
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  logFile: string;
  recentLog: string[];
}

export function daemonStatus(
  paths: DaemonPaths,
  tail = 5,
  deps: DaemonDeps = {},
): DaemonStatus {
  const pid = runningPid(paths, deps);
  const lines = existsSync(paths.logFile)
    ? readFileSync(paths.logFile, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return {
    running: pid !== null,
    pid,
    logFile: paths.logFile,
    recentLog: lines.slice(-tail),
  };
}
