import type { ModuleInfo } from "@pw-support/contracts";

export const laptopPlugin: ModuleInfo = {
  name: "plugin",
  owns: ["claims triage jobs from a laptop"],
};

export { type CliIo, runCli } from "./commands";
export { loadPluginConfig, type PluginConfig } from "./config";
export {
  type ClaudeRunner,
  createClaudeCliRunner,
  type RunInput,
  type RunReport,
  type SpawnedProcess,
  type Spawner,
} from "./runner";
export { SUBMIT_TOOL_FULL_NAME, type SubmitOutcome } from "./submit-server";
export { createSupportApi, type SupportApi } from "./support-api";
export { type TickResult, tick, type WatcherDeps } from "./watcher";
