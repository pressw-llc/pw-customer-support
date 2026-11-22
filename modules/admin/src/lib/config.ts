import { buildLogoutUrl } from "./logout";

export interface AdminConfig {
  apiUrl: string;
  authority: string;
  clientId: string;
  scope: string;
  logoutUrl: string;
  origin: string;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_SCOPE = "openid profile email";

function pick(runtime: EnvLike, env: EnvLike, name: string): string {
  return (runtime[name] || env[name] || "").trim();
}

export function resolveConfig(
  env: EnvLike,
  runtime: EnvLike,
  origin: string,
): AdminConfig {
  return {
    apiUrl: pick(runtime, env, "VITE_API_URL").replace(/\/+$/, ""),
    authority: pick(runtime, env, "VITE_OIDC_AUTHORITY"),
    clientId: pick(runtime, env, "VITE_OIDC_CLIENT_ID"),
    scope: pick(runtime, env, "VITE_OIDC_SCOPE") || DEFAULT_SCOPE,
    logoutUrl: pick(runtime, env, "VITE_OIDC_LOGOUT_URL"),
    origin,
  };
}

export const SIGNED_OUT_PATH = "/signed-out";

export function logoutEndpoint(config: AdminConfig): string | null {
  return buildLogoutUrl(config.logoutUrl, {
    clientId: config.clientId,
    logoutUri: `${config.origin}${SIGNED_OUT_PATH}`,
  });
}

export function configProblems(config: AdminConfig): string[] {
  const missing: string[] = [];
  if (!config.apiUrl) missing.push("VITE_API_URL");
  if (!config.authority) missing.push("VITE_OIDC_AUTHORITY");
  if (!config.clientId) missing.push("VITE_OIDC_CLIENT_ID");
  if (config.logoutUrl && !logoutEndpoint(config)) {
    missing.push("VITE_OIDC_LOGOUT_URL (invalid)");
  }
  return missing;
}

export async function loadRuntimeConfig(
  fetcher: typeof fetch = fetch,
): Promise<EnvLike> {
  try {
    const response = await fetcher("/config.json", { cache: "no-store" });
    if (!response.ok) return {};
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as EnvLike) : {};
  } catch {
    return {};
  }
}
