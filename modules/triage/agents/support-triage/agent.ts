import { defineAgent } from "@pressw-llc/managed-agents";
import { buildTriageSystemPrompt } from "@pw-support/contracts";

const model = process.env.TRIAGE_AGENT_MODEL || "claude-sonnet-5-5";

export const SYSTEM_PROMPT = buildTriageSystemPrompt("json");

export const definition = defineAgent({
  name: "pw-support-triage",
  model,
  system: SYSTEM_PROMPT,
  description: "Classifies and summarizes one support request as JSON.",
  tools: [],
  mcp_servers: [],
  skills: [],
  metadata: { repo_path: "modules/triage/agents/support-triage" },
});

export interface TriageEnvironmentConfig {
  type: "cloud";
  networking: {
    type: "limited";
    allowed_hosts: string[];
    allow_mcp_servers: boolean;
    allow_package_managers: boolean;
  };
}

export const environmentConfig: TriageEnvironmentConfig = {
  type: "cloud",
  networking: {
    type: "limited",
    allowed_hosts: [],
    allow_mcp_servers: false,
    allow_package_managers: false,
  },
};
