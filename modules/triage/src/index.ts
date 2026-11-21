import type { ModuleInfo } from "@pw-support/contracts";

export const triageWorker: ModuleInfo = {
  name: "triage",
  owns: ["runs triage jobs"],
};

export {
  claimTriageJob as claimJob,
  extendTriageLease as renewLease,
} from "@pw-support/db";
export {
  definition as triageAgentDefinition,
  environmentConfig as triageEnvironmentConfig,
} from "../agents/support-triage/agent";
export * from "./agent-runner";
export * from "./config";
export * from "./extract";
export * from "./filter";
export * from "./jev";
export * from "./parse";
export * from "./process";
export * from "./runtime";
export * from "./submit";
export * from "./testing/files";
export * from "./testing/harness";
export * from "./worker";
