import {
  configureFargateRuntime,
  fargateMain,
} from "@pressw-llc/pipeline";
import pipeline from "../pipeline.config";
import triage from "../steps/triage/index";

export async function runTriageWorker(options: {
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
    visibilityTimeoutSec: 60,
    shutdownSignal: options.signal,
  });
}
