import {
  createAdapterRuntime,
  createDispatcher,
  runPoller,
  sqsTransport,
} from "@pw-support/channels";
import { RESOURCE_NAMES } from "@pw-support/contracts";
import {
  createWorkerRuntime,
  resolveQueueUrl,
  startSweeper,
} from "@pw-support/triage";
import { handler as deliver } from "../pipelines/linear-outbound/lambda-entries/deliver";
import { runTriageWorker } from "../pipelines/support-triage/fargate-entries/worker";

const triage = createWorkerRuntime();
const channels = createAdapterRuntime();
const controller = new AbortController();
const log = (message: string, detail?: Record<string, unknown>) =>
  console.log(`[worker] ${message}`, detail ? JSON.stringify(detail) : "");

let stopping = false;
function stop() {
  if (stopping) process.exit(1);
  stopping = true;
  log("stopping");
  controller.abort();
  setTimeout(() => process.exit(0), 30_000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const wakeUrl = await resolveQueueUrl(triage.sqs, triage.deps.config.wakeQueue);
const adapterUrl = await resolveQueueUrl(
  triage.sqs,
  RESOURCE_NAMES.linearAdapterQueue,
);
const urls = new Map([[channels.linearAdapter.name, adapterUrl]]);

const dispatcher = createDispatcher({
  db: channels.db,
  adapters: [channels.linearAdapter],
  transport: sqsTransport({
    client: triage.sqs,
    queueUrlFor: async (name) => urls.get(name) as string,
  }),
  log,
});

log("started", {
  claimant: triage.deps.claimant,
  jev: triage.deps.jev !== null,
  leaseSeconds: triage.deps.config.timing.leaseSeconds,
});

await Promise.all([
  runTriageWorker({
    client: triage.sqs,
    queueUrl: wakeUrl,
    signal: controller.signal,
    waitTimeSeconds: 5,
  }),
  startSweeper(triage.deps, controller.signal),
  dispatcher.run(triage.deps.config.sweepIntervalMs, controller.signal),
  runPoller({
    client: triage.sqs,
    queueUrl: adapterUrl,
    signal: controller.signal,
    waitSeconds: 2,
    log,
    handler: async (event) =>
      (await deliver(event as never, {} as never, () => {})) as {
        batchItemFailures: { itemIdentifier: string }[];
      },
  }),
]);
await triage.close();
log("stopped");
process.exit(0);
