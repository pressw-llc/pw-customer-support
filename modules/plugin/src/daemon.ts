import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
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

export function readPid(paths: DaemonPaths): number | null {
  try {
    const pid = Number(readFileSync(paths.pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function runningPid(paths: DaemonPaths): number | null {
  const pid = readPid(paths);
  if (pid !== null && isAlive(pid)) return pid;
  if (pid !== null) rmSync(paths.pidFile, { force: true });
  return null;
}

export function writePid(paths: DaemonPaths, pid: number): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.pidFile, String(pid), { mode: 0o600 });
}

export function clearPid(paths: DaemonPaths, pid: number): void {
  if (readPid(paths) === pid) rmSync(paths.pidFile, { force: true });
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
}): Promise<StartResult> {
  const existing = runningPid(input.paths);
  if (existing !== null) return { started: false, pid: existing };
  mkdirSync(input.paths.dir, { recursive: true, mode: 0o700 });
  const fd = openSync(input.paths.logFile, "a", 0o600);
  try {
    const [bin, ...args] = input.command as [string, ...string[]];
    const child = spawn(bin, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: input.env,
    });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error("the watcher failed to start");
    writePid(input.paths, pid);
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
  options: { timeoutMs?: number } = {},
): Promise<StopResult> {
  const pid = runningPid(paths);
  if (pid === null) return "not_running";
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let result: StopResult = "stopped";
  if (isAlive(pid)) {
    process.kill(pid, "SIGKILL");
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

export function daemonStatus(paths: DaemonPaths, tail = 5): DaemonStatus {
  const pid = runningPid(paths);
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
