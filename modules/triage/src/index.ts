import type { ModuleInfo } from "@pw-support/contracts";

export const triageWorker: ModuleInfo = {
  name: "triage",
  owns: ["runs triage jobs"],
};
