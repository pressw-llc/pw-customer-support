import {
  createApp,
  createS3Storage,
  loadConfig,
  type ObjectStorage,
} from "@pw-support/api";
import {
  hashCustomerId,
  type TriageTiming,
  type WakeSender,
} from "@pw-support/contracts";
import {
  closeDb,
  createDb,
  ensureProject,
  getTriageJobForRequest,
  migrate,
  projects,
  type SupportDb,
  setProjectLinearTeam,
} from "@pw-support/db";
import { eq } from "drizzle-orm";
import type { AgentInput, AgentRunner } from "../agent-runner";
import { loadTriageConfig, type TriageConfig } from "../config";
import type { JevClient, JevSubject } from "../jev";
import type { WorkerDeps } from "../worker";

export class TestClock {
  private current: number;

  constructor(start: Date = new Date()) {
    this.current = start.getTime();
  }

  readonly now = (): Date => new Date(this.current);

  advance(seconds: number): void {
    this.current += seconds * 1000;
  }
}

export type JevBehavior = (subject: JevSubject) => number | Error;

export function fakeJev(
  behavior: JevBehavior = () => 0.01,
): JevClient & { calls: JevSubject[] } {
  const calls: JevSubject[] = [];
  return {
    calls,
    async judgeInjection(subject) {
      calls.push(subject);
      const result = behavior(subject);
      if (result instanceof Error) throw result;
      return { score: result, raw: { fake: true, noul: result } };
    },
  };
}

export const VALID_AGENT_REPLY = JSON.stringify({
  title: "Cannot sign in to the portal",
  summary: "The customer reports that sign in fails with a timeout error.",
  category: "bug",
  priority: "high",
  labels: ["bug"],
  needs_human: false,
});

export type AgentBehavior = (input: AgentInput) => string | Error;

export function fakeAgent(
  behavior: AgentBehavior = () => VALID_AGENT_REPLY,
): AgentRunner & { calls: AgentInput[]; sessionIds: string[] } {
  const calls: AgentInput[] = [];
  const sessionIds: string[] = [];
  return {
    calls,
    sessionIds,
    async run(input, hooks) {
      calls.push(input);
      const sessionId = `sesn_fake_${calls.length}`;
      sessionIds.push(sessionId);
      await hooks?.onSession?.(sessionId);
      const result = behavior(input);
      if (result instanceof Error) throw result;
      return { textOutput: result, sessionId };
    },
  };
}

export interface HarnessOptions {
  timing?: Partial<TriageTiming>;
  jev?: JevClient | null;
  agent?: AgentRunner;
  storage?: ObjectStorage;
  env?: Record<string, string>;
  wake?: WakeSender;
}

export interface Tenant {
  projectId: string;
  clientSlug: string;
  projectSlug: string;
  headers: Record<string, string>;
}

export interface Submitted {
  requestId: string;
  jobId: string;
  status: number;
}

export async function createTriageHarness(options: HarnessOptions = {}) {
  await migrate();
  const db: SupportDb = createDb();
  const clock = new TestClock();
  const apiConfig = loadConfig({});
  const storage = options.storage ?? createS3Storage(apiConfig);
  const config: TriageConfig = loadTriageConfig(options.env ?? {});
  config.timing = { ...config.timing, ...options.timing };
  const wakes: { jobId: string; delaySeconds: number }[] = [];
  const wake: WakeSender = {
    async send(jobId, delaySeconds) {
      wakes.push({ jobId, delaySeconds });
      await options.wake?.send(jobId, delaySeconds);
    },
  };
  const app = createApp({
    db,
    storage,
    config: apiConfig,
    wake,
    timing: config.timing,
    now: clock.now,
  });
  const clientSlug = `acme-triage-${crypto.randomUUID().slice(0, 8)}`;
  const agent = options.agent ?? fakeAgent();
  const jev = options.jev === undefined ? fakeJev() : options.jev;

  const deps: WorkerDeps = {
    db,
    storage,
    jev,
    agent,
    config,
    claimant: "cloud-test",
    now: clock.now,
    wake,
  };

  async function tenant(
    input: {
      teamId?: string | null;
      email?: string;
      projectSlug?: string;
    } = {},
  ): Promise<Tenant> {
    const projectSlug =
      input.projectSlug ?? `p-${crypto.randomUUID().slice(0, 8)}`;
    const { project, key } = await ensureProject(db, {
      clientSlug,
      projectSlug,
      name: "Portal",
    });
    if (input.teamId !== null) {
      await setProjectLinearTeam(db, {
        clientSlug,
        projectSlug,
        linearTeamId: input.teamId ?? "team-acme-support",
      });
    }
    const hashedId = await hashCustomerId(input.email ?? "ada@acme.test", key);
    return {
      projectId: project.id,
      clientSlug,
      projectSlug,
      headers: { "X-Support-Key": key, "X-Support-User": hashedId },
    };
  }

  async function submit(
    who: Tenant,
    text: string,
    files: { name: string; bytes: Uint8Array; type?: string }[] = [],
  ): Promise<Submitted> {
    const form = new FormData();
    form.set("text", text);
    for (const file of files) {
      form.append(
        "files",
        new File([file.bytes], file.name, {
          type: file.type ?? "application/octet-stream",
        }),
      );
    }
    const response = await app.request("/v1/requests", {
      method: "POST",
      headers: who.headers,
      body: form,
    });
    const body = (await response.json()) as { requestId: string };
    const job = await getTriageJobForRequest(db, body.requestId);
    return {
      requestId: body.requestId,
      jobId: job?.id ?? "",
      status: response.status,
    };
  }

  async function close(): Promise<void> {
    await db.delete(projects).where(eq(projects.clientSlug, clientSlug));
    await closeDb(db);
  }

  return {
    db,
    app,
    clock,
    config,
    deps,
    wakes,
    tenant,
    submit,
    close,
    agent,
    jev,
  };
}

export type TriageHarness = Awaited<ReturnType<typeof createTriageHarness>>;
