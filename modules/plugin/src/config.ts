import { homedir } from "node:os";
import { join } from "node:path";
import { LOCAL_MCP_CLIENT_ID, resolveStackEnv } from "@pw-support/contracts";

type EnvLike = Record<string, string | undefined>;

export interface PluginConfig {
  apiUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  scope: string;
  loginPort: number;
  configDir: string;
  model: string | undefined;
  claudeBin: string;
  pollSeconds: number;
  runTimeoutSeconds: number;
  maxBudgetUsd: number;
  maxTurns: number;
}

export const DEFAULT_API_URL = "http://127.0.0.1:8787";
export const DEFAULT_LOGIN_PORT = 53682;

function text(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function defaultConfigDir(env: EnvLike): string {
  const base = text(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(base, "pw-support");
}

export function loadPluginConfig(env: EnvLike = process.env): PluginConfig {
  return {
    apiUrl: (text(env.PW_SUPPORT_API_URL) ?? DEFAULT_API_URL).replace(
      /\/+$/,
      "",
    ),
    issuer: (
      text(env.PW_SUPPORT_ISSUER) ?? resolveStackEnv(env).localIssuer
    ).replace(/\/+$/, ""),
    clientId: text(env.PW_SUPPORT_CLIENT_ID) ?? LOCAL_MCP_CLIENT_ID,
    clientSecret: text(env.PW_SUPPORT_CLIENT_SECRET),
    scope: text(env.PW_SUPPORT_SCOPE) ?? "openid email profile",
    loginPort: Math.floor(
      positive(env.PW_SUPPORT_LOGIN_PORT, DEFAULT_LOGIN_PORT),
    ),
    configDir: text(env.PW_SUPPORT_CONFIG_DIR) ?? defaultConfigDir(env),
    model: text(env.PW_SUPPORT_MODEL),
    claudeBin: text(env.PW_SUPPORT_CLAUDE_BIN) ?? "claude",
    pollSeconds: positive(env.PW_SUPPORT_POLL_SECONDS, 10),
    runTimeoutSeconds: positive(env.PW_SUPPORT_RUN_TIMEOUT_SECONDS, 90),
    maxBudgetUsd: positive(env.PW_SUPPORT_MAX_BUDGET_USD, 0.5),
    maxTurns: Math.floor(positive(env.PW_SUPPORT_MAX_TURNS, 3)),
  };
}
