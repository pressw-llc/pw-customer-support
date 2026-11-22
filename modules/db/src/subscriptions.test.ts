import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultTiming, MCP_MAX_SUBSCRIPTIONS } from "@pw-support/contracts";
import { eq, inArray } from "drizzle-orm";
import {
  addSubscription,
  claimTriageJob,
  closeDb,
  createDb,
  ensureProject,
  events,
  getRequestDetailForEngineer,
  isJobOffered,
  listJobOffers,
  listSubscriptions,
  markIntakeComplete,
  migrate,
  persistInboundRequest,
  projects,
  queryRequestSummaries,
  removeSubscription,
  SubscriptionLimitError,
  subscriptions,
  upsertCustomer,
} from "./index";

const db = createDb();
const slug = `acme-sub-${crypto.randomUUID().slice(0, 8)}`;
const other = `${slug}x`;
const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => () => new Date(T0.getTime() + seconds * 1000);
const ada = { sub: `ada-${slug}`, email: "ada@pressw.test", name: null };
const bob = { sub: `bob-${slug}`, email: "bob@pressw.test", name: null };

async function openJob(client: string, projectSlug: string, user: string) {
  const { project } = await ensureProject(db, {
    clientSlug: client,
    projectSlug,
    name: projectSlug,
  });
  const customer = await upsertCustomer(db, project.id, user.padEnd(64, "0"));
  const created = await persistInboundRequest(
    db,
    { scope: { project, customer }, body: "help me" },
    { now: at(0) },
  );
  await markIntakeComplete(db, created.request.id, at(0));
  return created;
}

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db
    .delete(subscriptions)
    .where(inArray(subscriptions.engineerSub, [ada.sub, bob.sub]));
  await db.delete(projects).where(inArray(projects.clientSlug, [slug, other]));
  await closeDb(db);
});

describe("subscriptions", () => {
  test("adds once, lists, and removes with audit events", async () => {
    const first = await addSubscription(db, ada, slug);
    expect(first.created).toBe(true);
    const again = await addSubscription(db, ada, slug);
    expect(again.created).toBe(false);
    expect(
      (await listSubscriptions(db, ada.sub)).map((s) => s.channelPrefix),
    ).toEqual([slug]);
    expect(await listSubscriptions(db, bob.sub)).toEqual([]);
    expect(await removeSubscription(db, bob, slug)).toBe(false);
    expect(await removeSubscription(db, ada, slug)).toBe(true);
    expect(await removeSubscription(db, ada, slug)).toBe(false);
    const audit = await db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(eq(events.channelKey, slug));
    expect(audit.map((row) => row.type).sort()).toEqual([
      "mcp.subscription.added",
      "mcp.subscription.removed",
    ]);
    expect(JSON.stringify(audit)).toContain(ada.sub);
  });

  test("rejects an invalid prefix", async () => {
    await expect(addSubscription(db, ada, "acme:")).rejects.toThrow();
    await expect(addSubscription(db, ada, "a:b:c:d")).rejects.toThrow();
    await expect(addSubscription(db, ada, "ac%")).rejects.toThrow();
  });

  test("caps the subscriptions per engineer", async () => {
    const capped = { sub: `cap-${slug}`, email: null, name: null };
    for (let index = 0; index < MCP_MAX_SUBSCRIPTIONS; index++) {
      await addSubscription(db, capped, `p${index}`);
    }
    await expect(addSubscription(db, capped, "extra")).rejects.toBeInstanceOf(
      SubscriptionLimitError,
    );
    await db
      .delete(subscriptions)
      .where(eq(subscriptions.engineerSub, capped.sub));
  });
});

describe("job offers", () => {
  test("matches by whole segment and never by string prefix", async () => {
    const job = await openJob(slug, "p", "u");
    const sibling = await openJob(other, "p", "u");
    await addSubscription(db, ada, slug);
    await addSubscription(db, bob, `${slug}:other`);
    const options = { now: at(10), timing: defaultTiming };
    const adaOffers = await listJobOffers(db, ada.sub, options);
    expect(adaOffers.map((offer) => offer.jobId)).toEqual([job.job.id]);
    expect(await listJobOffers(db, bob.sub, options)).toEqual([]);
    expect(await isJobOffered(db, ada.sub, job.job.id, options)).toBe(true);
    expect(await isJobOffered(db, ada.sub, sibling.job.id, options)).toBe(
      false,
    );
    expect(await isJobOffered(db, bob.sub, job.job.id, options)).toBe(false);

    await addSubscription(db, bob, `${slug}:p`);
    expect(
      (await listJobOffers(db, bob.sub, options)).map((o) => o.jobId),
    ).toEqual([job.job.id]);
    await removeSubscription(db, bob, `${slug}:p`);
    await removeSubscription(db, bob, `${slug}:other`);
    await removeSubscription(db, ada, slug);
  });

  test("a string prefix of a client slug does not match", async () => {
    const short = slug.slice(0, slug.length - 2);
    await addSubscription(db, bob, short);
    const job = await openJob(slug, "q", "u");
    expect(await isJobOffered(db, bob.sub, job.job.id, { now: at(10) })).toBe(
      false,
    );
    await removeSubscription(db, bob, short);
  });

  test("hides claimed jobs, jobs a laptop already held, and jobs inside intake", async () => {
    await addSubscription(db, ada, slug);
    const claimedJob = await openJob(slug, "claimed", "u");
    const options = { now: at(10) };
    expect(
      (await listJobOffers(db, ada.sub, options)).map((o) => o.jobId),
    ).toContain(claimedJob.job.id);
    const won = await claimTriageJob(db, {
      jobId: claimedJob.job.id,
      kind: "laptop",
      claimant: ada.sub,
      now: at(10),
    });
    expect(won.won).toBe(true);
    expect(
      (await listJobOffers(db, ada.sub, options)).map((o) => o.jobId),
    ).not.toContain(claimedJob.job.id);
    expect(
      (await listJobOffers(db, ada.sub, { now: at(1000) })).map((o) => o.jobId),
    ).not.toContain(claimedJob.job.id);

    const { project } = await ensureProject(db, {
      clientSlug: slug,
      projectSlug: "fresh",
      name: "fresh",
    });
    const customer = await upsertCustomer(db, project.id, "f".repeat(64));
    const fresh = await persistInboundRequest(
      db,
      { scope: { project, customer }, body: "new" },
      { now: at(0) },
    );
    expect(
      (await listJobOffers(db, ada.sub, { now: at(10) })).map((o) => o.jobId),
    ).not.toContain(fresh.job.id);
    expect(
      (await listJobOffers(db, ada.sub, { now: at(10_000) })).map(
        (o) => o.jobId,
      ),
    ).toContain(fresh.job.id);
    await removeSubscription(db, ada, slug);
  });
});

describe("request queries", () => {
  test("returns metadata for any request and bodies only for subscribed channels", async () => {
    const mine = await openJob(slug, "view", "u");
    await addSubscription(db, ada, `${slug}:view`);
    const rows = await queryRequestSummaries(db, ada.sub, {
      channelPrefix: slug,
      limit: 50,
    });
    const row = rows.find((candidate) => candidate.id === mine.request.id);
    expect(row?.subscribed).toBe(true);
    expect(row?.job?.status).toBe("open");

    const bobRows = await queryRequestSummaries(db, bob.sub, {
      channelPrefix: `${slug}:view`,
      status: "open",
      limit: 5,
    });
    expect(bobRows[0]?.subscribed).toBe(false);
    expect(JSON.stringify(bobRows)).not.toContain("help me");

    const adaDetail = await getRequestDetailForEngineer(
      db,
      ada.sub,
      mine.request.id,
    );
    expect(adaDetail?.counts).toEqual({
      messages: 1,
      attachments: 0,
      characters: 7,
    });
    expect(JSON.stringify(adaDetail)).not.toContain("help me");
    const bobDetail = await getRequestDetailForEngineer(
      db,
      bob.sub,
      mine.request.id,
    );
    expect(JSON.stringify(bobDetail)).not.toContain("help me");
    expect(bobDetail?.events[0]?.type).toBe("request.created");
    expect(
      await getRequestDetailForEngineer(
        db,
        bob.sub,
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toBeNull();
    await removeSubscription(db, ada, `${slug}:view`);
  });
});
