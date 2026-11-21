import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  configureFargateRuntime,
  defaultFargateSqsAdapter,
  fargateMain,
} from "@pressw-llc/pipeline";
import pipeline from "../pipeline.config";
import triage from "../steps/triage/index";

const VISIBILITY_TIMEOUT_SECONDS = 60;

export async function runTriageWorker(options: {
  client: SQSClient;
  queueUrl: string;
  signal: AbortSignal;
  waitTimeSeconds?: number;
}): Promise<void> {
  configureFargateRuntime({});
  await fargateMain({
    pipeline,
    stepName: "triage",
    step: triage,
    queueUrl: options.queueUrl,
    sqs: defaultFargateSqsAdapter({
      queueUrl: options.queueUrl,
      client: options.client,
      waitTimeSeconds: options.waitTimeSeconds ?? 20,
      visibilityTimeoutSec: VISIBILITY_TIMEOUT_SECONDS,
    }),
    visibilityTimeoutSec: VISIBILITY_TIMEOUT_SECONDS,
    shutdownSignal: options.signal,
  });
}
