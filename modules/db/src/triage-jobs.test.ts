import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultTiming, humanTriageResult } from "@pw-support/contracts";
import { eq } from "drizzle-orm";
import {
  cloudAvailability,
  claimTriageJob,
  closeDb,
  createDb,
  ensureProject,
  events,
  extendTriageLease,
  getChannelDelay,
  getTriageJob,
  listCloudEligibleJobs,
  markIntakeComplete,
  migrate,
  persistInboundRequest,
  projects,
  recordAgentSession,
  releaseTriageJob,
  submitHumanTriage,
  submitTriageResult,
  upsertCustomer,
} from "./index";

const db = createDb();
const slug = `acme-jobs-${crypto.randomUUID().slice(0, 8)}`;
const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => () => new Date(T0.getTime() + seconds * 1000);
const validResult = {
  title: "Login fails",
  summary: "The customer cannot sign in.",
  category: "bug",
  priority: "high",
  labels: ["bug"],
  needs_human: false,
};

async function project(name: string) {
  const { project } = await ensureProject(db, {
    clientSlug: slug,
    projectSlug: name,
    name,
  });
  const customer = await upsertCustomer(db, project.id, "c".repeat(64));
  return { project, customer };
}

async function openJob(
  name: string,
  startSeconds: number,
  options: { timing?: typeof defaultTiming } = {},
) {
  const scope = await project(name);
  const created = await persistInboundRequest(
    db,
    { scope, body: "help" },
    { now: at(startSeconds), timing: options.timing },
  );
  await markIntakeComplete(db, created.request.id, at(startSeconds));
  return created;
}

async function eventTypesFor(requestId: string): Promise<string[]> {
  const rows = await db
    .select({ type: events.type, seq: events.seq })
    .from(events)
    .where(eq(events.requestId, requestId));
  return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map((r) => r.type);
}

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.clientSlug, slug));
  await closeDb(db);
});

describe("job opening", () => {
  test("opens the job and its event in the request transaction", async () => {
    const created = await openJob("open", 0);
    expect(created.job.status).toBe("open");
    expect(created.delaySeconds).toBe(60);
    expect(created.job.cloudAvailableAt.toISOString()).toBe(
      at(60)().toISOString(),
    );
    expect(await eventTypesFor(created.request.id)).toEqual([
      "request.created",
      "triage.job.opened",
    ]);
  });
});

describe("A9 concurrent claims", () => {
  test("A9 many parallel claims on one job yield exactly one winner", async () => {
    const { job } = await openJob("a9", 0);
    const attempts = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        claimTriageJob(db, {
          jobId: job.id,
          kind: "cloud",
          claimant: `worker-${index}`,
          now: at(61),
        }),
      ),
    );
    const winners = attempts.filter((attempt) => attempt.won);
    expect(winners).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.won)).toHaveLength(24);
    const stored = await getTriageJob(db, job.id);
    expect(stored?.status).toBe("claimed");
    expect(stored?.attempts).toBe(1);
  });

  test("A9 a laptop and a cloud claim race to one winner", async () => {
    const { job } = await openJob("a9b", 0);
    const results = await Promise.all([
      claimTriageJob(db, {
        jobId: job.id,
        kind: "laptop",
        claimant: "eng-1",
        now: at(61),
      }),
      claimTriageJob(db, {
        jobId: job.id,
        kind: "cloud",
        claimant: "worker-1",
        now: at(61),
      }),
    ]);
    expect(results.filter((result) => result.won)).toHaveLength(1);
  });
});

describe("A10 delay and backoff", () => {
  test("A10 three unclaimed jobs wait 60, 30, 15 seconds and a laptop claim resets to 60", async () => {
    const channel = "a10";
    const first = await openJob(channel, 0);
    expect(first.delaySeconds).toBe(60);
    expect(
      (
        await claimTriageJob(db, {
          jobId: first.job.id,
          kind: "cloud",
          claimant: "w",
          now: at(60),
        })
      ).won,
    ).toBe(true);

    const second = await openJob(channel, 100);
    expect(second.delaySeconds).toBe(30);
    expect(second.job.cloudAvailableAt.toISOString()).toBe(
      at(130)().toISOString(),
    );
    await claimTriageJob(db, {
      jobId: second.job.id,
      kind: "cloud",
      claimant: "w",
      now: at(130),
    });

    const third = await openJob(channel, 200);
    expect(third.delaySeconds).toBe(15);
    expect(third.job.cloudAvailableAt.toISOString()).toBe(
      at(215)().toISOString(),
    );
    await claimTriageJob(db, {
      jobId: third.job.id,
      kind: "cloud",
      claimant: "w",
      now: at(215),
    });
    expect(await getChannelDelay(db, `${slug}:${channel}`)).toBe(7);

    const fourth = await openJob(channel, 300);
    const laptop = await claimTriageJob(db, {
      jobId: fourth.job.id,
      kind: "laptop",
      claimant: "eng-1",
      now: at(301),
    });
    expect(laptop.won).toBe(true);
    expect(await getChannelDelay(db, `${slug}:${channel}`)).toBe(60);
    const fifth = await openJob(channel, 400);
    expect(fifth.delaySeconds).toBe(60);
  });

  test("the delay halves with integer floor down to zero", async () => {
    const channel = "floor";
    const seen: number[] = [];
    let clock = 0;
    for (let index = 0; index < 8; index++) {
      const created = await openJob(channel, clock);
      seen.push(created.delaySeconds);
      clock += created.delaySeconds + 1;
      await claimTriageJob(db, {
        jobId: created.job.id,
        kind: "cloud",
        claimant: "w",
        now: at(clock),
      });
    }
    expect(seen).toEqual([60, 30, 15, 7, 3, 1, 0, 0]);
  });

  test("a cloud claim before the delay ends loses", async () => {
    const { job } = await openJob("early", 0);
    const early = await claimTriageJob(db, {
      jobId: job.id,
      kind: "cloud",
      claimant: "w",
      now: at(59),
    });
    expect(early.won).toBe(false);
    const laptop = await claimTriageJob(db, {
      jobId: job.id,
      kind: "laptop",
      claimant: "eng",
      now: at(10),
    });
    expect(laptop.won).toBe(true);
  });
});

describe("A11 lease expiry", () => {
  test("A11 an expired laptop lease lets the cloud claim at once and a live lease blocks it", async () => {
    const { job, request } = await openJob("a11", 0);
    const laptop = await claimTriageJob(db, {
      jobId: job.id,
      kind: "laptop",
      claimant: "eng-1",
      now: at(5),
    });
    expect(laptop.won).toBe(true);
    const blocked = await claimTriageJob(db, {
      jobId: job.id,
      kind: "cloud",
      claimant: "w",
      now: at(100),
    });
    expect(blocked.won).toBe(false);
    expect(
      cloudAvailability((await getTriageJob(db, job.id)) as never, at(100)()),
    ).toEqual({ state: "leased", waitSeconds: 26 });
    const takeover = await claimTriageJob(db, {
      jobId: job.id,
      kind: "cloud",
      claimant: "w",
      now: at(125),
    });
    expect(takeover.won).toBe(true);
    if (takeover.won) expect(takeover.tookOverExpiredLease).toBe(true);
    expect(await eventTypesFor(request.id)).toEqual([
      "request.created",
      "triage.job.opened",
      "triage.job.claimed",
      "triage.job.lease_expired",
      "triage.job.claimed",
    ]);
    expect(await getChannelDelay(db, `${slug}:a11`)).toBe(60);
  });

  test("a lease extension moves the expiry and a stale token cannot extend", async () => {
    const { job } = await openJob("lease", 0);
    const claim = await claimTriageJob(db, {
      jobId: job.id,
      kind: "cloud",
      claimant: "w",
      now: at(61),
    });
    if (!claim.won) throw new Error("expected a win");
    const token = claim.job.claimToken as string;
    expect(
      await extendTriageLease(db, {
        jobId: job.id,
        claimToken: token,
        now: at(100),
      }),
    ).toBe(true);
    expect(
      (await getTriageJob(db, job.id))?.leaseExpiresAt?.toISOString(),
    ).toBe(at(220)().toISOString());
    expect(
      await extendTriageLease(db, {
        jobId: job.id,
        claimToken: crypto.randomUUID(),
        now: at(100),
      }),
    ).toBe(false);
  });
});

describe("result submission", () => {
  async function claimed(name: string) {
    const created = await openJob(name, 0);
    const claim = await claimTriageJob(db, {
      jobId: created.job.id,
      kind: "laptop",
      claimant: "eng-1",
      now: at(1),
    });
    if (!claim.won) throw new Error("expected a win");
    return { ...created, token: claim.job.claimToken as string };
  }

  test("a valid result completes the job and appends the accepted event", async () => {
    const { job, request, token } = await claimed("submit-ok");
    const result = await submitTriageResult(db, {
      jobId: job.id,
      claimToken: token,
      payload: validResult,
      now: at(5),
    });
    expect(result.ok).toBe(true);
    const stored = await getTriageJob(db, job.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.outcome).toBe("agent");
    expect((stored?.result as { result: { title: string } }).result.title).toBe(
      "Login fails",
    );
    expect((await eventTypesFor(request.id)).at(-1)).toBe(
      "triage.result.accepted",
    );
  });

  test("a stale or foreign token is refused", async () => {
    const { job, token } = await claimed("submit-stale");
    const stale = await submitTriageResult(db, {
      jobId: job.id,
      claimToken: crypto.randomUUID(),
      payload: validResult,
    });
    expect(stale).toEqual({ ok: false, reason: "stale_claim" });
    await submitTriageResult(db, {
      jobId: job.id,
      claimToken: token,
      payload: validResult,
    });
    const again = await submitTriageResult(db, {
      jobId: job.id,
      claimToken: token,
      payload: validResult,
    });
    expect(again).toEqual({ ok: false, reason: "stale_claim" });
  });

  test("an invalid result is rejected and the job reopens for the cloud at once", async () => {
    const { job, request, token } = await claimed("submit-bad");
    const result = await submitTriageResult(db, {
      jobId: job.id,
      claimToken: token,
      payload: { ...validResult, priority: "apocalyptic", extra: 1 },
      now: at(10),
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "invalid_payload") {
      expect(result.issues.length).toBeGreaterThan(0);
    }
    const stored = await getTriageJob(db, job.id);
    expect(stored?.status).toBe("open");
    expect(stored?.claimToken).toBeNull();
    expect(stored?.cloudAvailableAt.toISOString()).toBe(at(10)().toISOString());
    expect((await eventTypesFor(request.id)).at(-1)).toBe(
      "triage.result.rejected",
    );
    const cloud = await claimTriageJob(db, {
      jobId: job.id,
      kind: "cloud",
      claimant: "w",
      now: at(10),
    });
    expect(cloud.won).toBe(true);
  });

  test("human triage completes with the deterministic result and a reason", async () => {
    const { job, token } = await claimed("submit-human");
    const result = await submitHumanTriage(db, {
      jobId: job.id,
      claimToken: token,
      reason: "injection_flagged",
    });
    expect(result.ok).toBe(true);
    const stored = await getTriageJob(db, job.id);
    expect(stored?.outcome).toBe("human_triage");
    expect(stored?.result).toEqual({
      result: humanTriageResult(),
      humanTriageReason: "injection_flagged",
    });
  });

  test("release reopens a claimed job and records the agent session", async () => {
    const { job, token } = await claimed("release");
    await recordAgentSession(db, {
      jobId: job.id,
      claimToken: token,
      sessionId: "sesn_test",
    });
    expect((await getTriageJob(db, job.id))?.agentSessionId).toBe("sesn_test");
    expect(
      await releaseTriageJob(db, {
        jobId: job.id,
        claimToken: token,
        reason: "agent_error",
        now: at(3),
      }),
    ).toBe(true);
    expect((await getTriageJob(db, job.id))?.status).toBe("open");
    expect(
      await releaseTriageJob(db, {
        jobId: job.id,
        claimToken: token,
        reason: "again",
      }),
    ).toBe(false);
  });
});

describe("availability and sweeping", () => {
  test("intake that never completes becomes claimable after the grace period", async () => {
    const scope = await project("grace");
    const created = await persistInboundRequest(
      db,
      { scope, body: "help" },
      { now: at(0), timing: { ...defaultTiming, initialDelaySeconds: 0 } },
    );
    const early = await claimTriageJob(db, {
      jobId: created.job.id,
      kind: "cloud",
      claimant: "w",
      now: at(10),
    });
    expect(early.won).toBe(false);
    expect(cloudAvailability(created.job, at(1)())).toEqual({
      state: "waiting",
      waitSeconds: 5,
    });
    const late = await claimTriageJob(db, {
      jobId: created.job.id,
      kind: "cloud",
      claimant: "w",
      now: at(301),
    });
    expect(late.won).toBe(true);
  });

  test("the sweeper query returns open eligible jobs and expired leases only", async () => {
    const eligible = await openJob("sweep-open", 0);
    const early = await openJob("sweep-early", 1000);
    const expired = await openJob("sweep-expired", 0);
    await claimTriageJob(db, {
      jobId: expired.job.id,
      kind: "laptop",
      claimant: "eng",
      now: at(1),
    });
    const live = await openJob("sweep-live", 0);
    await claimTriageJob(db, {
      jobId: live.job.id,
      kind: "laptop",
      claimant: "eng",
      now: at(250),
    });
    const ids = (
      await listCloudEligibleJobs(db, { now: at(260), limit: 500 })
    ).map((job) => job.id);
    expect(ids).toContain(eligible.job.id);
    expect(ids).toContain(expired.job.id);
    expect(ids).not.toContain(early.job.id);
    expect(ids).not.toContain(live.job.id);
  });

  test("availability describes completed, leased, waiting, and claimable jobs", async () => {
    const opened = await openJob("avail", 0);
    const job = (await getTriageJob(db, opened.job.id)) as NonNullable<
      Awaited<ReturnType<typeof getTriageJob>>
    >;
    expect(cloudAvailability(job, at(10)())).toEqual({
      state: "waiting",
      waitSeconds: 50,
    });
    expect(cloudAvailability(job, at(60)())).toEqual({ state: "claimable" });
    expect(cloudAvailability({ ...job, status: "completed" }, at(0)())).toEqual({
      state: "completed",
    });
  });
});
