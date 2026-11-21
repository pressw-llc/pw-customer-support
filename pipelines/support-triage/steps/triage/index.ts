import { defineStep } from "@pressw-llc/pipeline/define";
import { getWorkerRuntime, handleWake } from "@pw-support/triage";
import { TriageInput, TriageOutput } from "./schema";

export default defineStep({
  input: TriageInput,
  output: TriageOutput,
  async handler(input) {
    const outcome = await handleWake(getWorkerRuntime().deps, input.jobId);
    return { action: outcome.action };
  },
});
