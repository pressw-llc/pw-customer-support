import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPid,
  createFileLogger,
  daemonPaths,
  daemonStatus,
  isAlive,
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
];

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
    writePid(paths, process.pid);
    expect(readPid(paths)).toBe(process.pid);
    expect(statSync(paths.pidFile).mode & 0o777).toBe(0o600);
    clearPid(paths, 1);
    expect(readPid(paths)).toBe(process.pid);
    clearPid(paths, process.pid);
    expect(readPid(paths)).toBeNull();
  });

  test("drops a stale pid and ignores garbage", () => {
    const paths = daemonPaths(dir);
    writePid(paths, 2 ** 22 + 12345);
    expect(isAlive(2 ** 22 + 12345)).toBe(false);
    expect(runningPid(paths)).toBeNull();
    expect(readPid(paths)).toBeNull();
    writePid(paths, 0);
    writeFileSync(paths.pidFile, "abc");
    expect(readPid(paths)).toBeNull();
    expect(isAlive(process.pid)).toBe(true);
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
