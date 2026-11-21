import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAgentLock } from "@pressw-llc/managed-agents";
import { createS3Storage, loadConfig } from "@pw-support/api";
import { closeDb, createDb } from "@pw-support/db";
import { type AgentRunner, createManagedAgentRunner } from "./agent-runner";
import { loadTriageConfig, type TriageConfig } from "./config";
import { createJevClient, type JevClient } from "./jev";
import { createSqsClient, createSqsWakeSender } from "./wake";
import type { WorkerDeps } from "./worker";

type EnvLike = Record<string, string | undefined>;

const AGENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agents",
  "support-triage",
);

export function resolveAgentId(
  config: TriageConfig,
  lockPath = join(AGENT_DIR, "agent.lock.json"),
): string | undefined {
  return config.agent.id ?? readAgentLock(lockPath)?.id;
}

export function jevFromEnv(
  config: TriageConfig,
  env: EnvLike = process.env,
): JevClient | null {
  const apiKey = env.TYPESAFE_API_KEY;
  return apiKey
    ? createJevClient({ apiKey, timeoutMs: config.jev.timeoutMs })
    : null;
}

function missingAgent(): AgentRunner {
  return {
    async run() {
      throw new Error(
        "triage agent is not synced; run bun run agent:sync or set TRIAGE_AGENT_ID",
      );
    },
  };
}

export type WorkerRuntime = ReturnType<typeof createWorkerRuntime>;

let sharedRuntime: WorkerRuntime | undefined;

export function getWorkerRuntime(): WorkerRuntime {
  sharedRuntime ??= createWorkerRuntime();
  return sharedRuntime;
}

export function setWorkerRuntime(runtime: WorkerRuntime | undefined): void {
  sharedRuntime = runtime;
}

export function createWorkerRuntime(env: EnvLike = process.env) {
  const config = loadTriageConfig(env);
  const db = createDb();
  const apiConfig = loadConfig(env);
  const sqs = createSqsClient(env);
  const agentId = resolveAgentId(config);
  const deps: WorkerDeps = {
    db,
    storage: createS3Storage(apiConfig),
    jev: jevFromEnv(config, env),
    agent: agentId
      ? createManagedAgentRunner({ agentId, timeoutMs: config.agent.timeoutMs })
      : missingAgent(),
    config,
    claimant:
      env.TRIAGE_WORKER_ID || `cloud-${crypto.randomUUID().slice(0, 8)}`,
    wake: createSqsWakeSender({ client: sqs, queueName: config.wakeQueue }),
    log: (message, detail) =>
      console.log(`[triage] ${message}`, detail ? JSON.stringify(detail) : ""),
  };
  return {
    deps,
    sqs,
    async close() {
      sqs.destroy();
      await closeDb(db);
    },
  };
}
