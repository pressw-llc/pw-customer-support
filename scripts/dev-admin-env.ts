import { LOCAL_OIDC_CLIENT_ID, resolveStackEnv } from "@pw-support/contracts";

export function adminDevEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  const fallback = (name: string, value: string) => {
    if (!merged[name]) merged[name] = value;
  };
  fallback("VITE_API_URL", `http://127.0.0.1:${env.API_PORT || 8787}`);
  fallback("VITE_OIDC_AUTHORITY", resolveStackEnv(env).localIssuer);
  fallback("VITE_OIDC_CLIENT_ID", LOCAL_OIDC_CLIENT_ID);
  return merged;
}
