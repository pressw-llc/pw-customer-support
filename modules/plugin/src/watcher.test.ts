import { describe, expect, test } from "bun:test";
import type { JobClaimResult, JobOffer } from "@pw-support/contracts";
import type { ClaudeRunner, RunInput, RunReport } from "./runner";
import { RateLimitedError, type SupportApi } from "./support-api";
import { abortableSleep, runWatcher, tick, type WatcherDeps } from "./watcher";

const JOB = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

const offer: JobOffer = {
  jobId: JOB,
  channelKey: "acme:p:u",
  createdAt: "2026-01-01T00:00:00.000Z",
  ageSeconds: 5,
  cloudAvailableAt: "2026-01-01T00:01:00.000Z",
  cloudWaitSeconds: 55,
  leaseSeconds: 3,
};

const ready: JobClaimResult = {
  status: "ready",
  jobId: JOB,
  claimToken: TOKEN,
  submitToken: "S".repeat(43),
  leaseExpiresAt: "2026-01-01T00:02:00.000Z",
  leaseSeconds: 3,
  content: [{ type: "text", text: "CUSTOMER-SECRET-TEXT" }],
};

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    toolSetOk: true,
    init: null,
    hookEvents: ["SessionStart"],
    violation: null,
    childEnvKeys: [],
    managedContext: "note",
    tools: ["mcp__pw_submit__submit_result"],
    mcpServers: [],
    outcome: { accepted: true },
    timedOut: false,
    aborted: false,
    exitCode: 0,
    permissionDenials: 0,
    turns: 2,
    costUsd: 0.01,
    digest: [],
    ...overrides,
  };
}

function harness(options: {
  offers?: JobOffer[];
  claim?: JobClaimResult;
  report?: RunReport | (() => Promise<RunReport>);
  renew?: boolean | Error;
  status?:
    | { state: "claimed" | "completed" | "not_held"; outcome: string | null }
    | Error;
}) {
  const logs: string[] = [];
  const calls: string[] = [];
  const inputs: RunInput[] = [];
  const api: SupportApi = {
    async offers() {
      calls.push("offers");
      return options.offers ?? [offer];
    },
    async claim() {
      calls.push("claim");
      return options.claim ?? ready;
    },
    async renew() {
      calls.push("renew");
      if (options.renew instanceof Error) throw options.renew;
      return options.renew ?? true;
    },
    async submit() {
      throw new Error("the watcher never submits");
    },
    async jobStatus() {
      calls.push("status");
      if (options.status instanceof Error) throw options.status;
      return options.status ?? { state: "not_held", outcome: null };
    },
    async close() {},
  };
  const runner: ClaudeRunner = {
    async run(input, signal) {
      calls.push("run");
      inputs.push(input);
      const value = options.report;
      if (typeof value === "function") {
        const pending = value();
        signal?.addEventListener("abort", () => {});
        return pending;
      }
      return value ?? report();
    },
  };
  const deps: WatcherDeps = {
    api,
    runner,
    sleep: async () => {},
    log: (event, detail) =>
      logs.push(`${event} ${JSON.stringify(detail ?? {})}`),
    pollMs: 10,
    runTimeoutMs: 1000,
  };
  return { deps, logs, calls, inputs };
}

describe("watcher tick", () => {
  test("is idle when nothing is offered", async () => {
    const h = harness({ offers: [] });
    expect(await tick(h.deps, new AbortController().signal)).toEqual({
      kind: "idle",
    });
    expect(h.calls).toEqual(["offers"]);
  });

  test("claims, runs the subagent with the prepared content only, and completes", async () => {
    const h = harness({});
    const reported: string[] = [];
    h.deps.onReport = (jobId) => reported.push(jobId);
    const result = await tick(h.deps, new AbortController().signal);
    expect(result).toEqual({ kind: "completed" });
    expect(reported).toEqual([JOB]);
    expect(h.calls).toEqual(["offers", "claim", "run"]);
    expect(h.inputs[0]).toEqual({
      jobId: JOB,
      claimToken: TOKEN,
      submitToken: "S".repeat(43),
      content: ready.content,
    });
    expect(JSON.stringify(h.inputs[0])).not.toContain("token-");
    expect(h.logs.join("\n")).not.toContain("CUSTOMER-SECRET");
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });

  test("resolves an uncertain delivery by reading the job state before logging", async () => {
    for (const reason of [
      "transport",
      "unknown_after_transport_error",
    ] as const) {
      const done = harness({
        report: report({ outcome: { accepted: false, reason } }),
        status: { state: "completed", outcome: "agent" },
      });
      expect(await tick(done.deps, new AbortController().signal)).toEqual({
        kind: "completed",
      });
      expect(done.calls).toContain("status");
      expect(done.logs.join("\n")).toContain("result accepted");
      expect(done.logs.join("\n")).not.toContain("result refused");
      const open = harness({
        report: report({ outcome: { accepted: false, reason } }),
        status: { state: "not_held", outcome: null },
      });
      expect(await tick(open.deps, new AbortController().signal)).toEqual({
        kind: "lapsed",
        why: "no_outcome",
      });
      expect(open.logs.join("\n")).not.toContain("result refused");
    }
    const unreachable = harness({
      report: report({
        outcome: { accepted: false, reason: "unknown_after_transport_error" },
      }),
      status: new Error("down"),
    });
    expect(
      (await tick(unreachable.deps, new AbortController().signal)).kind,
    ).toBe("lapsed");
    expect(unreachable.logs.join("\n")).toContain("unavailable");
    const refused = harness({
      report: report({
        outcome: { accepted: false, reason: "invalid_payload" },
      }),
    });
    expect(await tick(refused.deps, new AbortController().signal)).toEqual({
      kind: "refused",
    });
    expect(refused.calls).not.toContain("status");
  });

  test("skips a refused claim and a nothing-to-do claim without running", async () => {
    const refused = harness({
      claim: { status: "refused", reason: "lost_race" },
    });
    expect(await tick(refused.deps, new AbortController().signal)).toEqual({
      kind: "skipped",
      reason: "lost_race",
    });
    const nothing = harness({
      claim: { status: "nothing_to_do", nothingToDo: "injection_flagged" },
    });
    expect(await tick(nothing.deps, new AbortController().signal)).toEqual({
      kind: "nothing_to_do",
      reason: "injection_flagged",
    });
    expect(refused.calls).not.toContain("run");
    expect(nothing.calls).not.toContain("run");
  });

  test("does not retry a refused result and leaves the job to the cloud", async () => {
    const h = harness({
      report: report({
        outcome: { accepted: false, reason: "invalid_payload" },
      }),
    });
    expect(await tick(h.deps, new AbortController().signal)).toEqual({
      kind: "refused",
    });
    expect(h.calls.filter((call) => call === "run")).toHaveLength(1);
  });

  test("lets the lease lapse on timeout, tool set mismatch, abort, and no outcome", async () => {
    const cases: [Partial<RunReport>, string][] = [
      [{ outcome: null, timedOut: true }, "timeout"],
      [{ outcome: null, toolSetOk: false }, "tool_set"],
      [
        {
          outcome: null,
          violation: { kind: "foreign_tool_use", detail: "Bash" },
        },
        "guard",
      ],
      [{ outcome: null, aborted: true }, "aborted"],
      [{ outcome: null }, "no_outcome"],
    ];
    for (const [overrides, why] of cases) {
      const h = harness({ report: report(overrides) });
      expect(await tick(h.deps, new AbortController().signal)).toEqual({
        kind: "lapsed",
        why: why as "timeout",
      });
      expect(h.calls).not.toContain("renew-after");
    }
  });

  test("renews the lease on a heartbeat while the subagent runs", async () => {
    const h = harness({
      report: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2300));
        return report();
      },
    });
    await tick(h.deps, new AbortController().signal);
    expect(
      h.calls.filter((call) => call === "renew").length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("logs a failed renew and aborts the run when the lease is lost", async () => {
    let aborted = false;
    const h = harness({ renew: false });
    h.deps.runner = {
      run: (_input, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve(report({ outcome: null, aborted: true }));
          });
        }),
    };
    expect(await tick(h.deps, new AbortController().signal)).toEqual({
      kind: "lapsed",
      why: "aborted",
    });
    expect(aborted).toBe(true);
    expect(h.logs.join("\n")).toContain("lease lost");

    const failing = harness({
      renew: new Error("network"),
      report: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1300));
        return report();
      },
    });
    await tick(failing.deps, new AbortController().signal);
    expect(failing.logs.join("\n")).toContain("renew failed");
  });

  test("an external abort stops the run", async () => {
    const controller = new AbortController();
    const h = harness({});
    h.deps.runner = {
      run: (_input, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve(report({ outcome: null, aborted: true })),
          );
          controller.abort();
        }),
    };
    expect((await tick(h.deps, controller.signal)).kind).toBe("lapsed");
  });
});

describe("watcher loop", () => {
  test("polls until aborted, backs off after errors, and logs start and stop", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    let polls = 0;
    const h = harness({});
    h.deps.api = {
      ...h.deps.api,
      async offers() {
        polls += 1;
        if (polls === 1) throw new Error("down");
        if (polls === 2) return [];
        return [offer];
      },
    };
    h.deps.sleep = async (ms) => {
      waits.push(ms);
      if (waits.length === 3) controller.abort();
    };
    await runWatcher(h.deps, controller.signal);
    expect(waits[0]).toBe(20);
    expect(waits[1]).toBe(10);
    expect(waits[2]).toBe(1000);
    expect(h.logs[0]).toContain("watcher started");
    expect(h.logs.at(-1)).toContain("watcher stopped");
    expect(h.logs.join("\n")).toContain("tick failed");
  });

  test("sleeps the normal poll interval after nothing to do and after a skipped claim", async () => {
    for (const claim of [
      { status: "nothing_to_do", nothingToDo: "injection_flagged" },
      { status: "refused", reason: "lost_race" },
    ] as JobClaimResult[]) {
      const controller = new AbortController();
      const waits: number[] = [];
      const h = harness({ claim });
      h.deps.sleep = async (ms) => {
        waits.push(ms);
        controller.abort();
      };
      await runWatcher(h.deps, controller.signal);
      expect(waits).toEqual([10]);
    }
  });

  test("backs off on a 429 and honors Retry-After", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    const h = harness({});
    h.deps.api = {
      ...h.deps.api,
      async offers() {
        throw new RateLimitedError(45);
      },
    };
    h.deps.sleep = async (ms) => {
      waits.push(ms);
      if (waits.length === 2) controller.abort();
    };
    await runWatcher(h.deps, controller.signal);
    expect(waits).toEqual([45_000, 45_000]);
    expect(h.logs.join("\n")).toContain("rate limited");
    const tiny = harness({});
    const stop = new AbortController();
    const tinyWaits: number[] = [];
    tiny.deps.api = {
      ...tiny.deps.api,
      async offers() {
        throw new RateLimitedError(0);
      },
    };
    tiny.deps.sleep = async (ms) => {
      tinyWaits.push(ms);
      stop.abort();
    };
    await runWatcher(tiny.deps, stop.signal);
    expect(tinyWaits).toEqual([10]);
  });

  test("abortableSleep resolves on timeout and on abort", async () => {
    const controller = new AbortController();
    await abortableSleep(5, controller.signal);
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort();
    await pending;
    await abortableSleep(60_000, controller.signal);
  });
});
