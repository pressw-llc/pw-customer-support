import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  createSqsClient,
  createSqsWakeSender,
  resolveQueueUrl,
} from "@pw-support/api";
import {
  createAdapterRuntime,
  createDispatcher,
  runPoller,
  setAdapterRuntime,
  sqsTransport,
} from "@pw-support/channels";
import { startLinearStub } from "@pw-support/channels/testing";
import {
  advanceEventCursor,
  findTicketByRequest,
  getTriageJob,
  maxEventSeq,
  requestHasEvent,
} from "@pw-support/db";
import { setWorkerRuntime } from "@pw-support/triage";
import {
  createTriageHarness,
  type TriageHarness,
} from "@pw-support/triage/testing";
import { handler as deliver } from "./linear-outbound/lambda-entries/deliver";
import linearPipeline from "./linear-outbound/pipeline.config";
import { runTriageWorker } from "./support-triage/fargate-entries/worker";
import triagePipeline from "./support-triage/pipeline.config";

const suffix = crypto.randomUUID().slice(0, 8);
const wakeQueue = `pw-support-test-wake-${suffix}`;
const adapterQueue = `pw-support-test-linear-${suffix}`;
const sqs: SQSClient = createSqsClient({});
const stub = startLinearStub();
let h: TriageHarness;

function runtimeFor(harness: TriageHarness) {
  return {
    deps: harness.deps,
    sqs,
    verifyAgent: async () => [] as string[],
    close: async () => {},
  };
}
let wakeUrl = "";
let adapterUrl = "";

beforeAll(async () => {
  for (const name of [wakeQueue, adapterQueue]) {
    await sqs.send(new CreateQueueCommand({ QueueName: name }));
  }
  wakeUrl = await resolveQueueUrl(sqs, wakeQueue);
  adapterUrl = await resolveQueueUrl(sqs, adapterQueue);
  h = await createTriageHarness({
    timing: { initialDelaySeconds: 0 },
    wake: createSqsWakeSender({ client: sqs, queueName: wakeQueue }),
  });
  setWorkerRuntime(runtimeFor(h));
  setAdapterRuntime(
    createAdapterRuntime(
      { LINEAR_API_URL: stub.url },
      { db: h.db, secrets: { get: async () => "lin_test" } },
    ),
  );
});

afterAll(async () => {
  setWorkerRuntime(undefined);
  setAdapterRuntime(undefined);
  for (const url of [wakeUrl, adapterUrl]) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  }
  await stub.stop();
  await h.close();
  sqs.destroy();
});

async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("pipeline definitions", () => {
  test("the triage step runs on Fargate and the adapter step on Lambda", () => {
    expect(triagePipeline.graph.triage?.runtime).toBe("fargate");
    expect(linearPipeline.graph.deliver?.runtime).toBe("lambda");
  });
});

describe("the Fargate entry runs the sweeper", () => {
  test("C3 a job whose wake was never sent is completed by the sweeper started in runTriageWorker", async () => {
    const quiet = await createTriageHarness({
      timing: { initialDelaySeconds: 0 },
    });
    quiet.deps.config.sweepIntervalMs = 200;
    setWorkerRuntime(runtimeFor(quiet));
    const controller = new AbortController();
    const worker = runTriageWorker({
      client: sqs,
      queueUrl: wakeUrl,
      signal: controller.signal,
      waitTimeSeconds: 1,
    });
    try {
      const who = await quiet.tenant();
      const { jobId } = await quiet.submit(who, "Lost wake message.");
      const job = await until(async () => {
        const row = await getTriageJob(quiet.db, jobId);
        return row?.status === "completed" ? row : null;
      }, "the sweeper to complete the job");
      expect(job.outcome).toBe("agent");
    } finally {
      controller.abort();
      await worker;
      setWorkerRuntime(runtimeFor(h));
      await quiet.close();
    }
  }, 30_000);
});

describe("T15 and T5 on the local stack", () => {
  test("A3 A8 a request flows through the Fargate worker, the dispatcher, the Lambda handler, and the SQS poller to one ticket", async () => {
    const controller = new AbortController();
    const worker = runTriageWorker({
      client: sqs,
      queueUrl: wakeUrl,
      signal: controller.signal,
      waitTimeSeconds: 1,
    });
    const poller = runPoller({
      client: sqs,
      queueUrl: adapterUrl,
      signal: controller.signal,
      waitSeconds: 1,
      handler: async (event) =>
        (await deliver(event as never, {} as never, () => {})) as {
          batchItemFailures: { itemIdentifier: string }[];
        },
    });
    const adapterName = `linear-test-${suffix}`;
    await advanceEventCursor(h.db, adapterName, await maxEventSeq(h.db));
    const dispatcher = createDispatcher({
      db: h.db,
      adapters: [
        {
          ...createAdapterRuntime(
            { LINEAR_API_URL: stub.url },
            { db: h.db, secrets: { get: async () => "k" } },
          ).linearAdapter,
          name: adapterName,
        },
      ],
      transport: sqsTransport({
        client: sqs,
        queueUrlFor: async () => adapterUrl,
      }),
    });
    try {
      const who = await h.tenant();
      const { requestId, jobId } = await h.submit(
        who,
        "Sign in fails with a timeout after the update.",
      );
      const job = await until(async () => {
        const row = await getTriageJob(h.db, jobId);
        return row?.status === "completed" ? row : null;
      }, "the job to complete");
      expect(job.claimedByKind).toBe("cloud");
      expect(job.outcome).toBe("agent");
      const ticket = await until(async () => {
        await dispatcher.tick();
        return findTicketByRequest(h.db, requestId);
      }, "the ticket");
      expect(ticket.identifier).toMatch(/^ACME-\d+$/);
      expect(
        stub.issues.filter((issue) => issue.description.includes(requestId)),
      ).toHaveLength(1);
      expect(await requestHasEvent(h.db, requestId, "ticket.created")).toBe(
        true,
      );
    } finally {
      controller.abort();
      await Promise.all([worker, poller]);
    }
  }, 40_000);
});
