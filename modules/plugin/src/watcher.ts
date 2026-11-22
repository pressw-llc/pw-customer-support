import type { ClaudeRunner, RunReport } from "./runner";
import type { SupportApi } from "./support-api";

export type LogDetail = Record<string, string | number | boolean | null>;

export interface WatcherDeps {
  api: SupportApi;
  runner: ClaudeRunner;
  getToken: (minValiditySeconds: number) => Promise<string>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: (event: string, detail?: LogDetail) => void;
  pollMs: number;
  runTimeoutMs: number;
}

export type TickResult =
  | { kind: "idle" }
  | { kind: "skipped"; reason: string }
  | { kind: "nothing_to_do"; reason: string }
  | { kind: "completed" }
  | { kind: "refused" }
  | { kind: "lapsed"; why: "timeout" | "tool_set" | "aborted" | "no_outcome" };

const MIN_HEARTBEAT_MS = 1000;
const MAX_BACKOFF_MS = 120_000;
const TOKEN_MARGIN_SECONDS = 60;

function lapseReason(
  report: RunReport,
): "timeout" | "tool_set" | "aborted" | "no_outcome" {
  if (report.timedOut) return "timeout";
  if (!report.toolSetOk) return "tool_set";
  if (report.aborted) return "aborted";
  return "no_outcome";
}

export async function tick(
  deps: WatcherDeps,
  signal: AbortSignal,
): Promise<TickResult> {
  const offers = await deps.api.offers();
  const offer = offers[0];
  if (!offer) return { kind: "idle" };
  const claim = await deps.api.claim(offer.jobId);
  if (claim.status === "refused") {
    deps.log("claim refused", { job: offer.jobId, reason: claim.reason });
    return { kind: "skipped", reason: claim.reason };
  }
  if (claim.status === "nothing_to_do") {
    deps.log("nothing to do", { job: offer.jobId, reason: claim.nothingToDo });
    return { kind: "nothing_to_do", reason: claim.nothingToDo };
  }
  deps.log("claimed", { job: claim.jobId, leaseSeconds: claim.leaseSeconds });
  const run = new AbortController();
  const stop = () => run.abort();
  signal.addEventListener("abort", stop);
  const heartbeat = setInterval(
    async () => {
      try {
        const renewed = await deps.api.renew(claim.jobId, claim.claimToken);
        if (!renewed) {
          deps.log("lease lost", { job: claim.jobId });
          run.abort();
        }
      } catch (error) {
        deps.log("renew failed", {
          job: claim.jobId,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    },
    Math.max(MIN_HEARTBEAT_MS, (claim.leaseSeconds * 1000) / 3),
  );
  try {
    const accessToken = await deps.getToken(
      Math.ceil(deps.runTimeoutMs / 1000) + TOKEN_MARGIN_SECONDS,
    );
    const report = await deps.runner.run(
      {
        jobId: claim.jobId,
        claimToken: claim.claimToken,
        accessToken,
        content: claim.content,
      },
      run.signal,
    );
    deps.log("subagent finished", {
      job: claim.jobId,
      tools: report.tools?.length ?? null,
      toolSetOk: report.toolSetOk,
      exitCode: report.exitCode,
      turns: report.turns,
      permissionDenials: report.permissionDenials,
    });
    if (report.outcome?.accepted) {
      deps.log("result accepted", { job: claim.jobId });
      return { kind: "completed" };
    }
    if (report.outcome) {
      deps.log("result refused; job reopened for the cloud", {
        job: claim.jobId,
        reason: report.outcome.reason,
      });
      return { kind: "refused" };
    }
    const why = lapseReason(report);
    deps.log("lease left to lapse", { job: claim.jobId, why });
    return { kind: "lapsed", why };
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", stop);
  }
}

export async function runWatcher(
  deps: WatcherDeps,
  signal: AbortSignal,
): Promise<void> {
  let failures = 0;
  deps.log("watcher started");
  while (!signal.aborted) {
    let wait = deps.pollMs;
    try {
      const result = await tick(deps, signal);
      failures = 0;
      if (result.kind !== "idle") wait = MIN_HEARTBEAT_MS;
    } catch (error) {
      failures += 1;
      wait = Math.min(MAX_BACKOFF_MS, deps.pollMs * 2 ** Math.min(failures, 6));
      deps.log("tick failed", {
        error: error instanceof Error ? error.name : "unknown",
        failures,
      });
    }
    if (signal.aborted) break;
    await deps.sleep(wait, signal);
  }
  deps.log("watcher stopped");
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}
