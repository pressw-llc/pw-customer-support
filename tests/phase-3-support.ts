import { createApp, createS3Storage, loadConfig } from "@pw-support/api";
import {
  createLinearAdapter,
  createLinearClient,
  createLinearWebhookIntake,
  type WordingScore,
  type WordingScorer,
} from "@pw-support/channels";
import {
  freshConnectionFetch,
  type LinearStub,
  STUB_HOST,
  startLinearStub,
} from "@pw-support/channels/testing";
import {
  type EventEnvelope,
  intakeResultSchema,
  requestListSchema,
  threadSchema,
} from "@pw-support/contracts";
import {
  events,
  findTicketByRequest,
  getEventBySeq,
  inboundComments,
  messages,
  replies,
} from "@pw-support/db";
import { handleWake } from "@pw-support/triage";
import {
  createTriageHarness,
  fakeAgent,
  fakeJev,
  type TriageHarness,
} from "@pw-support/triage/testing";
import { and, asc, eq, inArray } from "drizzle-orm";

export const WEBHOOK_SECRET = "whsec_phase3_test_secret";

export type Tenant = Awaited<ReturnType<TriageHarness["tenant"]>>;

export interface Scorer extends WordingScorer {
  calls: string[];
}

export function textScorer(
  fn: (text: string) => number | Error = () => 4,
): Scorer {
  const calls: string[] = [];
  return {
    calls,
    async score(text): Promise<WordingScore> {
      calls.push(text);
      const result = fn(text);
      if (result instanceof Error) throw result;
      return { score: result, raw: { fake: true, score: result } };
    },
  };
}

export const markedScore = (text: string): number | Error => {
  const hit = /\[s=([0-9.]+|ERR)\]/.exec(text);
  if (!hit) return 4;
  return hit[1] === "ERR" ? new Error("jev down") : Number(hit[1]);
};

export async function createPhase3Harness(
  options: { wording?: WordingScorer | null; secret?: string | null } = {},
) {
  const stub: LinearStub = startLinearStub();
  const h = await createTriageHarness({
    agent: fakeAgent(),
    jev: fakeJev(() => 0.02),
  });
  const secrets = {
    async get(name: string): Promise<string> {
      if (name === "linear-webhook-secret") {
        if (options.secret === null) throw new Error("not configured");
        return options.secret ?? WEBHOOK_SECRET;
      }
      return "lin_api_test";
    },
  };
  const linear = createLinearClient({
    apiUrl: stub.url,
    secrets,
    fetcher: freshConnectionFetch,
  });
  const wording =
    options.wording === undefined ? textScorer(markedScore) : options.wording;
  const adapter = createLinearAdapter({
    db: h.db,
    linear,
    wording,
    now: h.clock.now,
  });
  const apiConfig = loadConfig({});
  const intake = createLinearWebhookIntake({ db: h.db, secrets });
  const app = createApp({
    db: h.db,
    storage: createS3Storage(apiConfig),
    config: apiConfig,
    linearWebhook: intake,
  });
  const server = Bun.serve({
    port: 0,
    hostname: STUB_HOST,
    idleTimeout: 0,
    fetch: app.fetch,
  });
  const webhookUrl = `http://${STUB_HOST}:${server.port}/webhooks/linear`;
  stub.configureWebhook({ url: webhookUrl, secret: WEBHOOK_SECRET });
  const seen = new Set<number>();

  async function scenario(text = "Where is my invoice?") {
    const who = await h.tenant({ teamId: stub.teams[0]?.id });
    const submitted = await h.submit(who, text);
    h.clock.advance(61);
    await handleWake(h.deps, submitted.jobId);
    const [accepted] = await h.db
      .select({ seq: events.seq })
      .from(events)
      .where(
        and(
          eq(events.requestId, submitted.requestId),
          eq(events.type, "triage.result.accepted"),
        ),
      );
    const event = await getEventBySeq(h.db, accepted?.seq as number);
    if (!event) throw new Error("accepted event missing");
    await adapter.handle(event, { now: h.clock.now });
    seen.add(event.seq);
    const ticket = await findTicketByRequest(h.db, submitted.requestId);
    if (!ticket) throw new Error("ticket missing");
    return {
      who,
      requestId: submitted.requestId,
      issueId: ticket.linearIssueId,
    };
  }

  async function drain(requestId: string): Promise<EventEnvelope[]> {
    const handled: EventEnvelope[] = [];
    for (let round = 0; round < 5; round++) {
      const rows = await h.db
        .select({ seq: events.seq })
        .from(events)
        .where(
          and(
            eq(events.requestId, requestId),
            inArray(events.type, [...adapter.subscribes]),
          ),
        )
        .orderBy(asc(events.seq));
      const fresh = rows.filter((row) => !seen.has(row.seq));
      if (fresh.length === 0) break;
      for (const row of fresh) {
        seen.add(row.seq);
        const event = await getEventBySeq(h.db, row.seq);
        if (event) {
          await adapter.handle(event, { now: h.clock.now });
          handled.push(event);
        }
      }
    }
    return handled;
  }

  async function call(who: Tenant, path: string, init: RequestInit = {}) {
    return app.request(`/v1${path}`, { ...init, headers: who.headers });
  }

  async function thread(who: Tenant, requestId: string) {
    const response = await call(who, `/requests/${requestId}`);
    return threadSchema.parse(await response.json());
  }

  async function unread(who: Tenant, requestId: string): Promise<number> {
    const response = await call(who, "/requests");
    const list = requestListSchema.parse(await response.json());
    return list.requests.find((r) => r.id === requestId)?.unreadCount ?? 0;
  }

  async function followUp(who: Tenant, requestId: string, text: string) {
    const form = new FormData();
    form.set("text", text);
    const response = await call(who, `/requests/${requestId}/messages`, {
      method: "POST",
      body: form,
    });
    return intakeResultSchema.parse(await response.json());
  }

  async function storedMessages(requestId: string) {
    return h.db
      .select()
      .from(messages)
      .where(eq(messages.requestId, requestId))
      .orderBy(asc(messages.createdAt), asc(messages.id));
  }

  async function inboundFor(requestId: string) {
    return h.db
      .select()
      .from(inboundComments)
      .where(eq(inboundComments.requestId, requestId))
      .orderBy(asc(inboundComments.createdAt));
  }

  async function repliesFor(requestId: string) {
    return h.db
      .select()
      .from(replies)
      .where(eq(replies.requestId, requestId))
      .orderBy(asc(replies.createdAt));
  }

  async function eventTypes(requestId: string): Promise<string[]> {
    const rows = await h.db
      .select({ type: events.type })
      .from(events)
      .where(eq(events.requestId, requestId))
      .orderBy(asc(events.seq));
    return rows.map((row) => row.type);
  }

  async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function close(): Promise<void> {
    await stub.stop();
    await server.stop(true);
    await h.close();
  }

  return {
    stub,
    h,
    linear,
    adapter,
    app,
    server,
    webhookUrl,
    scenario,
    drain,
    call,
    thread,
    unread,
    followUp,
    storedMessages,
    inboundFor,
    repliesFor,
    eventTypes,
    waitFor,
    wording,
    close,
  };
}

export type Phase3Harness = Awaited<ReturnType<typeof createPhase3Harness>>;
