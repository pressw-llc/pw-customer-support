import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
import {
  clearPid,
  createFileLogger,
  daemonPaths,
  daemonStatus,
  inspectDaemon,
  isAlive,
  pruneReports,
  readPid,
  runningPid,
  startDaemon,
  stopDaemon,
  writePid,
} from "./daemon";

let dir: string;
const env = { PATH: process.env.PATH ?? "" };
const SLEEPER = [
  process.execPath,
  "-e",
  "console.log('up'); setInterval(() => {}, 1000)",
  "watch",
  "run",
];
const NONCE = "a".repeat(32);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pw-support-daemon-"));
});

afterEach(async () => {
  await stopDaemon(daemonPaths(dir), { timeoutMs: 2000 });
  rmSync(dir, { recursive: true, force: true });
});

describe("pid files", () => {
  test("writes, reads, and clears only its own pid", () => {
    const paths = daemonPaths(dir);
    expect(readPid(paths)).toBeNull();
    writePid(paths, process.pid, NONCE);
    expect(readPid(paths)).toBe(process.pid);
    expect(statSync(paths.pidFile).mode & 0o777).toBe(0o600);
    clearPid(paths, 1);
    expect(readPid(paths)).toBe(process.pid);
    clearPid(paths, process.pid);
    expect(readPid(paths)).toBeNull();
  });

  test("drops a stale pid and ignores garbage", () => {
    const paths = daemonPaths(dir);
    writePid(paths, 2 ** 22 + 12345, NONCE);
    expect(isAlive(2 ** 22 + 12345)).toBe(false);
    expect(runningPid(paths)).toBeNull();
    expect(readPid(paths)).toBeNull();
    writePid(paths, 0, NONCE);
    expect(readPid(paths)).toBeNull();
    writeFileSync(paths.pidFile, "abc");
    expect(readPid(paths)).toBeNull();
    writeFileSync(paths.pidFile, String(process.pid));
    expect(readPid(paths)).toBeNull();
    expect(isAlive(process.pid)).toBe(true);
  });

  test("an unrelated live process behind a stale pid file is neither trusted nor signalled", async () => {
    const paths = daemonPaths(dir);
    const bystander = Bun.spawn(["sleep", "30"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      writePid(paths, bystander.pid, NONCE);
      expect(isAlive(bystander.pid)).toBe(true);
      const signals: string[] = [];
      const deps = {
        kill: (_pid: number, signal: string) => signals.push(signal),
      };
      expect(runningPid(paths)).toBeNull();
      expect(readPid(paths)).toBeNull();
      writePid(paths, bystander.pid, NONCE);
      expect(await stopDaemon(paths, { deps })).toBe("not_running");
      expect(signals).toEqual([]);
      expect(daemonStatus(paths).running).toBe(false);
      expect(isAlive(bystander.pid)).toBe(true);
    } finally {
      bystander.kill();
    }
  });

  test("when ps cannot answer the pid is unverified: the file stays and nothing is signalled or started", async () => {
    const paths = daemonPaths(dir);
    writePid(paths, process.pid, NONCE);
    const signals: string[] = [];
    const deps = {
      commandLine: () => null,
      kill: (_pid: number, signal: string) => signals.push(signal),
    };
    expect(inspectDaemon(paths, deps)).toEqual({
      state: "unverified",
      pid: process.pid,
    });
    expect(runningPid(paths, deps)).toBeNull();
    expect(readPid(paths)).toBe(process.pid);
    expect(await stopDaemon(paths, { deps })).toBe("unverified");
    expect(signals).toEqual([]);
    const status = daemonStatus(paths, 5, deps);
    expect(status.unverified).toBe(true);
    expect(status.running).toBe(false);
    await expect(
      startDaemon({ paths, command: SLEEPER, env, deps }),
    ).rejects.toThrow("cannot verify");
    expect(readPid(paths)).toBe(process.pid);
  });

  test("a process with the watcher command line but another nonce is rejected", () => {
    const paths = daemonPaths(dir);
    writePid(paths, process.pid, NONCE);
    const deps = {
      commandLine: () => `bun cli.ts watch run --nonce ${"b".repeat(32)}`,
    };
    expect(runningPid(paths, deps)).toBeNull();
    writePid(paths, process.pid, NONCE);
    const matching = {
      commandLine: () => `bun cli.ts watch run --nonce ${NONCE}`,
    };
    expect(runningPid(paths, matching)).toBe(process.pid);
  });
});

describe("run reports", () => {
  test("keeps only the newest reports and ignores other files", () => {
    const runs = join(dir, "runs");
    mkdirSync(runs);
    for (let index = 0; index < 5; index++) {
      const path = join(runs, `run-${index}.json`);
      writeFileSync(path, "{}");
      const at = new Date(Date.now() - (5 - index) * 1000);
      utimesSync(path, at, at);
    }
    writeFileSync(join(runs, "note.txt"), "keep");
    pruneReports(runs, 2);
    expect(readdirSync(runs).sort()).toEqual([
      "note.txt",
      "run-3.json",
      "run-4.json",
    ]);
  });
});

describe("logger", () => {
  test("appends one line per event with a private file", () => {
    const paths = daemonPaths(dir);
    mkdirSync(paths.dir, { recursive: true });
    const log = createFileLogger(
      paths.logFile,
      () => new Date("2026-01-01T00:00:00Z"),
    );
    log("claimed", { job: "j1" });
    log("idle");
    expect(readFileSync(paths.logFile, "utf8")).toBe(
      '2026-01-01T00:00:00.000Z claimed {"job":"j1"}\n2026-01-01T00:00:00.000Z idle\n',
    );
    expect(statSync(paths.logFile).mode & 0o777).toBe(0o600);
    const broken = createFileLogger(join(dir, "missing", "x.log"));
    expect(() => broken("ignored")).not.toThrow();
  });
});

describe("daemon lifecycle", () => {
  test("starts detached, refuses a second start, reports status, and stops cleanly", async () => {
    const paths = daemonPaths(dir);
    const first = await startDaemon({ paths, command: SLEEPER, env });
    expect(first.started).toBe(true);
    expect(isAlive(first.pid)).toBe(true);
    const again = await startDaemon({ paths, command: SLEEPER, env });
    expect(again).toEqual({ started: false, pid: first.pid });
    const status = daemonStatus(paths);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(first.pid);
    expect(status.recentLog.join("\n")).toContain("up");
    expect(await stopDaemon(paths)).toBe("stopped");
    expect(isAlive(first.pid)).toBe(false);
    expect(daemonStatus(paths).running).toBe(false);
    expect(await stopDaemon(paths)).toBe("not_running");
  });

  test("reports a watcher that exits at startup", async () => {
    await expect(
      startDaemon({
        paths: daemonPaths(dir),
        command: [process.execPath, "-e", "process.exit(3)"],
        env,
        settleMs: 500,
      }),
    ).rejects.toThrow("exited at startup");
    expect(readPid(daemonPaths(dir))).toBeNull();
    expect(daemonStatus(daemonPaths(dir)).recentLog).toEqual([]);
  });

  test("kills a watcher that ignores SIGTERM", async () => {
    const paths = daemonPaths(dir);
    const stubborn = [
      process.execPath,
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      "watch",
      "run",
    ];
    const started = await startDaemon({
      paths,
      command: stubborn,
      env,
      settleMs: 500,
    });
    expect(await stopDaemon(paths, { timeoutMs: 300 })).toBe("killed");
    expect(isAlive(started.pid)).toBe(false);
  });
});
