import { RESOURCE_NAMES, type TriageResult } from "@pw-support/contracts";
import {
  claimTriageJob,
  closeDb,
  createDb,
  ensureProject,
  events,
  getEventBySeq,
  markIntakeComplete,
  migrate,
  persistInboundRequest,
  projects,
  recordAttachment,
  type SupportDb,
  setProjectLinearTeam,
  submitHumanTriage,
  submitTriageResult,
  upsertCustomer,
} from "@pw-support/db";
import { and, eq } from "drizzle-orm";
import { createLinearAdapter, type LinearAdapter } from "../linear/adapter";
import { createLinearClient, type LinearClient } from "../linear/client";
import { type LinearStub, startLinearStub } from "./linear-stub";

export const VALID_RESULT: TriageResult = {
  title: "Cannot sign in",
  summary: "The customer reports a sign in timeout.",
  category: "bug",
  priority: "high",
  labels: ["bug", "ux"],
  needs_human: false,
};

export class OffsetClock {
  private offsetMs = 0;

  readonly now = (): Date => new Date(Date.now() + this.offsetMs);

  advance(seconds: number): void {
    this.offsetMs += seconds * 1000;
  }
}

export async function createChannelsHarness() {
  await migrate();
  const db: SupportDb = createDb();
  const stub: LinearStub = startLinearStub();
  const linear: LinearClient = createLinearClient({
    apiUrl: stub.url,
    secrets: { get: async () => "lin_api_test" },
  });
  const clock = new OffsetClock();
  const adapter: LinearAdapter = createLinearAdapter({
    db,
    linear,
    now: clock.now,
  });
  const clientSlug = `acme-ch-${crypto.randomUUID().slice(0, 8)}`;
  const team = stub.teams[0]?.id as string;

  async function project(options: { teamId?: string | null } = {}) {
    const projectSlug = `p-${crypto.randomUUID().slice(0, 8)}`;
    const { project } = await ensureProject(db, {
      clientSlug,
      projectSlug,
      name: "Portal",
    });
    if (options.teamId !== null) {
      await setProjectLinearTeam(db, {
        clientSlug,
        projectSlug,
        linearTeamId: options.teamId ?? team,
      });
    }
    return { project, projectSlug };
  }

  async function completedRequest(
    input: {
      project?: Awaited<ReturnType<typeof project>>;
      text?: string;
      result?: unknown;
      human?: boolean;
      files?: string[];
    } = {},
  ) {
    const scope = input.project ?? (await project());
    const customer = await upsertCustomer(db, scope.project.id, "d".repeat(64));
    const when = new Date();
    const created = await persistInboundRequest(
      db,
      {
        scope: { project: scope.project, customer },
        body: input.text ?? "Sign in fails with a timeout.",
      },
      {
        now: () => when,
        timing: {
          initialDelaySeconds: 0,
          leaseSeconds: 60,
          maxAttempts: 3,
          intakeGraceSeconds: 300,
        },
      },
    );
    await markIntakeComplete(db, created.request.id, () => when);
    for (const filename of input.files ?? []) {
      await recordAttachment(db, {
        messageId: created.message.id,
        filename,
        contentType: "text/plain",
        sizeBytes: 5,
        storageKey: `k/${filename}`,
        sha256: "0".repeat(64),
      });
    }
    const claim = await claimTriageJob(db, {
      jobId: created.job.id,
      kind: "cloud",
      claimant: "test",
      now: () => when,
    });
    if (!claim.won) throw new Error("expected a claim");
    const token = claim.job.claimToken as string;
    if (input.human) {
      await submitHumanTriage(db, {
        jobId: created.job.id,
        claimToken: token,
        reason: "injection_flagged",
      });
    } else {
      await submitTriageResult(db, {
        jobId: created.job.id,
        claimToken: token,
        payload: input.result ?? VALID_RESULT,
      });
    }
    const [accepted] = await db
      .select({ seq: events.seq })
      .from(events)
      .where(
        and(
          eq(events.requestId, created.request.id),
          eq(events.type, "triage.result.accepted"),
        ),
      );
    const event = await getEventBySeq(db, accepted?.seq as number);
    if (!event) throw new Error("accepted event missing");
    return { ...created, event, projectScope: scope };
  }

  async function close(): Promise<void> {
    await stub.stop();
    await db.delete(projects).where(eq(projects.clientSlug, clientSlug));
    await closeDb(db);
  }

  return {
    db,
    stub,
    linear,
    adapter,
    clock,
    team,
    clientSlug,
    project,
    completedRequest,
    close,
    adapterQueue: RESOURCE_NAMES.linearAdapterQueue,
  };
}

export type ChannelsHarness = Awaited<ReturnType<typeof createChannelsHarness>>;
