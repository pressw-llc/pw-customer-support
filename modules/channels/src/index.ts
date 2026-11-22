import type { ModuleInfo } from "@pw-support/contracts";

export const channelAdapters: ModuleInfo = {
  name: "channels",
  owns: ["syncs external channels"],
};

export * from "./dispatcher";
export * from "./linear/adapter";
export * from "./linear/client";
export * from "./linear/ticket";
export * from "./poller";
export * from "./runtime";
