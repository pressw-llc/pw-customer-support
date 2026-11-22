import type { PluginConfig } from "./config";
import { clearPid, createFileLogger, daemonPaths, writePid } from "./daemon";
import { getAccessToken } from "./oauth";
import { createClaudeCliRunner } from "./runner";
import { createSupportApi } from "./support-api";
import { createFileTokenStore } from "./token-store";
import { abortableSleep, runWatcher } from "./watcher";

export async function runWatchCommand(input: {
  config: PluginConfig;
  cliPath: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  const { config } = input;
  const paths = daemonPaths(config.configDir);
  const store = createFileTokenStore(config.configDir);
  const getToken = (minValiditySeconds: number) =>
    getAccessToken({
      config,
      store,
      fetcher: input.fetcher,
      minValiditySeconds,
    });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  writePid(paths, process.pid);
  try {
    await runWatcher(
      {
        api: createSupportApi({
          apiUrl: config.apiUrl,
          getToken: () => getToken(0),
        }),
        runner: createClaudeCliRunner({ config, cliPath: input.cliPath }),
        getToken,
        sleep: abortableSleep,
        log: createFileLogger(paths.logFile),
        pollMs: config.pollSeconds * 1000,
        runTimeoutMs: config.runTimeoutSeconds * 1000,
      },
      controller.signal,
    );
  } finally {
    clearPid(paths, process.pid);
  }
}
