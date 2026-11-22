import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultTiming } from "@pw-support/contracts";
import { eq, inArray } from "drizzle-orm";
import {
  claimTriageJob,
  closeDb,
  createDb,
  ensureProject,
  findJobBySubmitCredential,
  getTriageJob,
  hashSecret,
  isWatcherValid,
  markIntakeComplete,
  migrate,
  persistInboundRequest,
  projects,
  registerWatcher,
  releaseTriageJob,
  revokeWatcher,
  setSubmitCredential,
  upsertCustomer,
  watcherCredentials,
} from "./index";

const db = createDb();
const slug = `acme-cred-${crypto.randomUUID().slice(0, 8)}`;
const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => () => new Date(T0.getTime() + seconds * 1000);
const sub = `eng-${slug}`;
const machine = crypto.randomUUID();
const secret = "A".repeat(43);

async function claimedJob(name: string) {
  const { project } = await ensureProject(db, {
    clientSlug: slug,
    projectSlug: name,
    name,
  });
  const customer = await upsertCustomer(db, project.id, "c".repeat(64));
  const created = await persistInboundRequest(
    db,
    { scope: { project, customer }, body: "help" },
    { now: at(0) },
  );
  await markIntakeComplete(db, created.request.id, at(0));
  const claim = await claimTriageJob(db, {
    jobId: created.job.id,
    kind: "laptop",
    claimant: sub,
    now: at(1),
  });
  if (!claim.won) throw new Error("expected a win");
  return { jobId: created.job.id, token: claim.job.claimToken as string };
}

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db
    .delete(watcherCredentials)
    .where(eq(watcherCredentials.engineerSub, sub));
  await db.delete(projects).where(inArray(projects.clientSlug, [slug]));
  await closeDb(db);
});

describe("watcher credentials", () => {
  test("stores only a hash, validates per engineer and machine, and revokes", async () => {
    await registerWatcher(db, { engineerSub: sub, machineId: machine, secret });
    const [row] = await db
      .select()
      .from(watcherCredentials)
      .where(eq(watcherCredentials.engineerSub, sub));
    expect(row?.secretHash).toBe(hashSecret(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    const check = (
      input: Partial<{
        engineerSub: string;
        machineId: string;
        secret: string;
      }>,
    ) =>
      isWatcherValid(db, {
        engineerSub: sub,
        machineId: machine,
        secret,
        ...input,
      });
    expect(await check({})).toBe(true);
    expect(await check({ engineerSub: "someone-else" })).toBe(false);
    expect(await check({ machineId: crypto.randomUUID() })).toBe(false);
    expect(await check({ secret: "B".repeat(43) })).toBe(false);
    expect(
      await revokeWatcher(db, { engineerSub: sub, machineId: machine }),
    ).toBe(true);
    expect(await check({})).toBe(false);
    expect(
      await revokeWatcher(db, { engineerSub: sub, machineId: machine }),
    ).toBe(false);
    await registerWatcher(db, { engineerSub: sub, machineId: machine, secret });
    expect(await check({})).toBe(true);
  });
});

describe("submit credentials", () => {
  test("resolve to the claimed job until the lease ends or the job reopens", async () => {
    const { jobId, token } = await claimedJob("submit-cred");
    const value = "C".repeat(43);
    expect(
      await setSubmitCredential(db, {
        jobId,
        claimToken: token,
        secret: value,
        now: at(2),
      }),
    ).toBe(true);
    const found = await findJobBySubmitCredential(db, {
      secret: value,
      now: at(3),
    });
    expect(found?.id).toBe(jobId);
    expect(
      await findJobBySubmitCredential(db, {
        secret: "D".repeat(43),
        now: at(3),
      }),
    ).toBeNull();
    expect(
      await findJobBySubmitCredential(db, {
        secret: value,
        now: at(1 + defaultTiming.leaseSeconds),
      }),
    ).toBeNull();
    await releaseTriageJob(db, {
      jobId,
      claimToken: token,
      reason: "test",
      now: at(4),
    });
    expect((await getTriageJob(db, jobId))?.submitTokenHash).toBeNull();
    expect(
      await findJobBySubmitCredential(db, { secret: value, now: at(5) }),
    ).toBeNull();
  });

  test("a stale claim token or an expired lease cannot set one", async () => {
    const { jobId, token } = await claimedJob("submit-cred-stale");
    expect(
      await setSubmitCredential(db, {
        jobId,
        claimToken: crypto.randomUUID(),
        secret: "E".repeat(43),
        now: at(2),
      }),
    ).toBe(false);
    expect(
      await setSubmitCredential(db, {
        jobId,
        claimToken: token,
        secret: "E".repeat(43),
        now: at(1 + defaultTiming.leaseSeconds),
      }),
    ).toBe(false);
  });
});
