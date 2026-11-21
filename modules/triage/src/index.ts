import type { ModuleInfo } from "@pw-support/contracts";

export const triageWorker: ModuleInfo = {
  name: "triage",
  owns: ["runs triage jobs"],
};

export {
  claimTriageJob as claimJob,
  extendTriageLease as renewLease,
  submitTriageResult as submitResult,
} from "@pw-support/db";
export * from "./agent-runner";
export * from "./config";
export * from "./extract";
export * from "./filter";
export * from "./jev";
export * from "./parse";
export * from "./process";
export * from "./runtime";
export * from "./worker";
