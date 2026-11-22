import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "./config";
import {
  clearPid,
  createFileLogger,
  daemonPaths,
  pruneReports,
  writePid,
} from "./daemon";
import { getAccessToken } from "./oauth";
import { createClaudeCliRunner, purgeStaleRuns, staleRunAgeMs } from "./runner";
import { createSupportApi, registerWatcher } from "./support-api";
import { createFileTokenStore } from "./token-store";
import { abortableSleep, runWatcher } from "./watcher";
import { createWatcherCredentialStore } from "./watcher-credential";

const MAX_REPORTS = 50;

export async function runWatchCommand(input: {
  config: PluginConfig;
  cliPath: string;
  fetcher?: typeof fetch;
  nonce?: string;
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
  const credential = createWatcherCredentialStore(config.configDir).ensure();
  await registerWatcher(
    {
      apiUrl: config.apiUrl,
      token: await getToken(0),
      fetcher: input.fetcher,
    },
    credential,
  );
  const log = createFileLogger(paths.logFile);
  const purged = purgeStaleRuns(
    tmpdir(),
    staleRunAgeMs(config.runTimeoutSeconds * 1000),
  );
  if (purged > 0) log("purged stale run directories", { count: purged });
  const reportDir = config.reportDir ?? join(paths.dir, "runs");
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  if (input.nonce) writePid(paths, process.pid, input.nonce);
  const api = createSupportApi({
    apiUrl: config.apiUrl,
    getToken: () => getToken(0),
    watcher: credential,
    fetcher: input.fetcher,
  });
  try {
    await runWatcher(
      {
        api,
        runner: createClaudeCliRunner({ config, cliPath: input.cliPath }),
        sleep: abortableSleep,
        log,
        pollMs: config.pollSeconds * 1000,
        runTimeoutMs: config.runTimeoutSeconds * 1000,
        onReport: (jobId, report) => {
          writeFileSync(
            join(reportDir, `run-${jobId}.json`),
            JSON.stringify(report, null, 2),
            { mode: 0o600 },
          );
          pruneReports(reportDir, MAX_REPORTS);
        },
      },
      controller.signal,
    );
  } finally {
    await api.close();
    clearPid(paths, process.pid);
  }
}
