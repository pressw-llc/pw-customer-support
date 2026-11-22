export interface LogoutValues {
  clientId: string;
  logoutUri: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function fill(template: string, values: LogoutValues): string {
  return template
    .replaceAll("{client_id}", encodeURIComponent(values.clientId))
    .replaceAll("{logout_uri}", encodeURIComponent(values.logoutUri));
}

export function buildLogoutUrl(
  template: string,
  values: LogoutValues,
): string | null {
  if (!template.trim()) return null;
  try {
    const url = new URL(fill(template.trim(), values));
    const secure =
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOOPBACK.has(url.hostname));
    return secure ? url.href : null;
  } catch {
    return null;
  }
}
