import type { WakeSender } from "@pw-support/contracts";
import {
  type SubmitInput,
  type SubmitResult,
  type SupportDb,
  submitTriageResult,
} from "@pw-support/db";

export interface SubmitDeps {
  db: SupportDb;
  wake: WakeSender;
}

export async function submitResult(
  deps: SubmitDeps,
  input: SubmitInput,
): Promise<SubmitResult> {
  const result = await submitTriageResult(deps.db, input);
  if (!result.ok && result.reason === "invalid_payload") {
    await deps.wake.send(input.jobId, 0);
  }
  return result;
}
