import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginConfig, type PluginConfig } from "./config";
import { daemonPaths, daemonStatus, startDaemon, stopDaemon } from "./daemon";
import {
  clientCredentialsLogin,
  getAccessToken,
  LoginError,
  loopbackLogin,
  NotLoggedInError,
} from "./oauth";
import { revokeWatcher } from "./support-api";
import { createFileTokenStore } from "./token-store";
import { createWatcherCredentialStore } from "./watcher-credential";

type EnvLike = Record<string, string | undefined>;

export interface CliIo {
  env: EnvLike;
  out: (text: string) => void;
  err: (text: string) => void;
  openUrl: (url: string) => void | Promise<void>;
  fetcher?: typeof fetch;
  cliPath: string;
  overrides?: Partial<PluginConfig>;
}

export const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

const USAGE = [
  "usage: pw-support <command>",
  "  login [--no-browser] [--client-credentials]",
  "  logout",
  "  token",
  "  headers",
  "  watch start|stop|status|run",
].join("\n");

export function openInBrowser(url: string, launch: typeof spawn = spawn): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = launch(opener, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

export function defaultIo(): CliIo {
  return {
    env: process.env,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    openUrl: openInBrowser,
    cliPath: CLI_PATH,
  };
}

async function login(args: string[], config: PluginConfig, io: CliIo) {
  const store = createFileTokenStore(config.configDir);
  if (args.includes("--client-credentials")) {
    await clientCredentialsLogin({ config, store, fetcher: io.fetcher });
    io.out("Logged in with the client credentials grant.");
    return;
  }
  await loopbackLogin({
    config,
    store,
    fetcher: io.fetcher,
    openUrl: args.includes("--no-browser")
      ? (url) => io.out(`Open this URL to log in:\n${url}`)
      : async (url) => {
          io.out(
            "Opening the browser to log in. If nothing opens, use this URL:",
          );
          io.out(url);
          await io.openUrl(url);
        },
  });
  io.out("Logged in.");
}

async function watch(args: string[], config: PluginConfig, io: CliIo) {
  const paths = daemonPaths(config.configDir);
  const sub = args[0];
  if (sub === "start") {
    const result = await startDaemon({
      paths,
      command: [process.execPath, io.cliPath, "watch", "run"],
      env: Object.fromEntries(
        Object.entries(io.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
    io.out(
      result.started
        ? `Watcher started (pid ${result.pid}). Log: ${paths.logFile}`
        : `Watcher is already running (pid ${result.pid}).`,
    );
    return;
  }
  if (sub === "stop") {
    const result = await stopDaemon(paths);
    io.out(
      result === "not_running"
        ? "Watcher is not running."
        : result === "unverified"
          ? "Cannot verify the process behind the watcher pid file. Nothing was signalled."
          : `Watcher ${result}.`,
    );
    return;
  }
  if (sub === "status") {
    const status = daemonStatus(paths);
    io.out(
      status.running
        ? `Watcher is running (pid ${status.pid}). Log: ${status.logFile}`
        : status.unverified
          ? `Cannot verify the process behind the watcher pid file (pid ${status.pid}).`
          : "Watcher is not running.",
    );
    for (const line of status.recentLog) io.out(line);
    return;
  }
  if (sub === "run") {
    const { runWatchCommand } = await import("./run-watch");
    const nonceAt = args.indexOf("--nonce");
    await runWatchCommand({
      config,
      cliPath: io.cliPath,
      fetcher: io.fetcher,
      nonce: nonceAt >= 0 ? args[nonceAt + 1] : undefined,
    });
    return;
  }
  throw new LoginError("usage: pw-support watch start|stop|status|run");
}

async function logout(config: PluginConfig, io: CliIo) {
  const credentials = createWatcherCredentialStore(config.configDir);
  const credential = credentials.read();
  let revocation: "none" | "revoked" | "failed" = "none";
  if (credential) {
    try {
      const revoked = await revokeWatcher(
        {
          apiUrl: config.apiUrl,
          token: await currentToken(config, io),
          fetcher: io.fetcher,
        },
        credential.machineId,
      );
      revocation = revoked ? "revoked" : "failed";
    } catch {
      revocation = "failed";
    }
  }
  await stopDaemon(daemonPaths(config.configDir));
  credentials.clear();
  createFileTokenStore(config.configDir).clear();
  io.out("Logged out.");
  if (revocation === "failed") {
    io.err(
      "The server did not confirm the watcher credential revocation. Run pw-support login and pw-support logout again while online.",
    );
  }
}

async function currentToken(config: PluginConfig, io: CliIo) {
  return getAccessToken({
    config,
    store: createFileTokenStore(config.configDir),
    fetcher: io.fetcher,
  });
}

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo(),
): Promise<number | undefined> {
  const [command, ...args] = argv;
  const config = loadPluginConfig(io.env, io.overrides);
  try {
    switch (command) {
      case "login":
        await login(args, config, io);
        return 0;
      case "logout":
        await logout(config, io);
        return 0;
      case "token":
        io.out(await currentToken(config, io));
        return 0;
      case "headers":
        io.out(
          JSON.stringify({
            Authorization: `Bearer ${await currentToken(config, io)}`,
          }),
        );
        return 0;
      case "watch":
        await watch(args, config, io);
        return 0;
      case "submit-server": {
        const path = args[0];
        if (!path) {
          throw new LoginError("usage: pw-support submit-server <config>");
        }
        const { runSubmitServerFromFile } = await import("./submit-main");
        await runSubmitServerFromFile(path);
        return undefined;
      }
      default:
        io.err(USAGE);
        return command === undefined || command === "help" ? 0 : 2;
    }
  } catch (error) {
    if (error instanceof NotLoggedInError || error instanceof LoginError) {
      io.err(error.message);
      return 1;
    }
    io.err(
      `pw-support failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return 1;
  }
}
