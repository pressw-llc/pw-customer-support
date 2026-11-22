import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  configureFargateRuntime,
  defaultFargateSqsAdapter,
  fargateMain,
} from "@pressw-llc/pipeline";
import { TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS } from "@pw-support/contracts";
import { getWorkerRuntime, startSweeper } from "@pw-support/triage";
import pipeline from "../pipeline.config";
import triage from "../steps/triage/index";

export async function runTriageWorker(options: {
  client: SQSClient;
  queueUrl: string;
  signal: AbortSignal;
  waitTimeSeconds?: number;
}): Promise<void> {
  configureFargateRuntime({});
  const runtime = getWorkerRuntime();
  await runtime.verifyAgent();
  await Promise.all([
    fargateMain({
      pipeline,
      stepName: "triage",
      step: triage,
      queueUrl: options.queueUrl,
      sqs: defaultFargateSqsAdapter({
        queueUrl: options.queueUrl,
        client: options.client,
        waitTimeSeconds: options.waitTimeSeconds ?? 20,
        visibilityTimeoutSec: TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
      }),
      visibilityTimeoutSec: TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
      shutdownSignal: options.signal,
    }),
    startSweeper(runtime.deps, options.signal),
  ]);
}
