import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncAgent } from "@pressw-llc/managed-agents";
import { definition } from "./agent";

const lockPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "agent.lock.json",
);
const result = await syncAgent(definition, lockPath);
console.log(
  `[agent:sync] ${result.action} ${result.lock.name} ${result.lock.id} v${result.lock.version} model ${definition.model}`,
);
