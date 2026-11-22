import { resolveQueueUrl } from "@pw-support/api";
import {
  type AdapterRuntime,
  createAdapterRuntime,
  createDispatcher,
  runPoller,
  setAdapterRuntime,
  sqsTransport,
} from "@pw-support/channels";
import { RESOURCE_NAMES } from "@pw-support/contracts";
import {
  createWorkerRuntime,
  runExtractionSelfTest,
  setWorkerRuntime,
} from "@pw-support/triage";
import { handler as deliver } from "../../linear-outbound/lambda-entries/deliver";
import { runTriageWorker } from "./worker";

const SHUTDOWN_GRACE_MS = 30_000;

export interface MainOptions {
  channels?: AdapterRuntime;
  pollAdapterQueue?: boolean;
}

export async function main(options: MainOptions = {}): Promise<void> {
  await runExtractionSelfTest();
  const triage = createWorkerRuntime();
  setWorkerRuntime(triage);
  const channels = options.channels ?? createAdapterRuntime();
  setAdapterRuntime(channels);
  const controller = new AbortController();
  const log = (message: string, detail?: Record<string, unknown>) =>
    console.log(`[worker] ${message}`, detail ? JSON.stringify(detail) : "");

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("stopping");
    controller.abort();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const wakeUrl = await resolveQueueUrl(
    triage.sqs,
    triage.deps.config.wakeQueue,
  );
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
    dispatcher.run(triage.deps.config.sweepIntervalMs, controller.signal),
    options.pollAdapterQueue === false
      ? Promise.resolve()
      : runPoller({
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
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
