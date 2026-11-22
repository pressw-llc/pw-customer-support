import { z } from "zod";
import type { PluginConfig } from "./config";
import { cliCommand } from "./hint";
import { createPkce } from "./pkce";
import type { StoredTokens, TokenStore } from "./token-store";

export class NotLoggedInError extends Error {
  constructor(
    message = `not logged in; run the login command: ${cliCommand("login")}`,
  ) {
    super(message);
    this.name = "NotLoggedInError";
  }
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

type Fetcher = typeof fetch;
type Clock = () => number;

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
});
export type Discovery = z.infer<typeof discoverySchema>;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive().default(3600),
});

export const EXPIRY_SKEW_SECONDS = 60;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const systemClock: Clock = () => Date.now();

export async function discover(
  issuer: string,
  fetcher: Fetcher = fetch,
): Promise<Discovery> {
  const base = issuer.replace(/\/+$/, "");
  const response = await fetcher(`${base}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new LoginError("issuer discovery failed");
  const document = discoverySchema.parse(await response.json());
  if (document.issuer.replace(/\/+$/, "") !== base) {
    throw new LoginError("issuer discovery mismatch");
  }
  return document;
}

export function buildAuthorizeUrl(input: {
  endpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(input.endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function tokenRequest(
  endpoint: string,
  params: Record<string, string>,
  fetcher: Fetcher,
  config: Pick<PluginConfig, "clientSecret">,
  now: Clock,
): Promise<Omit<StoredTokens, "issuer" | "clientId" | "grant">> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (config.clientSecret && params.grant_type !== "client_credentials") {
    body.set("client_secret", config.clientSecret);
  }
  const response = await fetcher(endpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new LoginError(
      `token endpoint refused the request (${response.status})`,
    );
  }
  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new LoginError("token endpoint returned no token");
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: Math.floor(now() / 1000) + parsed.data.expires_in,
  };
}

export interface LoopbackOptions {
  config: PluginConfig;
  store: TokenStore;
  openUrl: (url: string) => void | Promise<void>;
  fetcher?: Fetcher;
  now?: Clock;
  timeoutMs?: number;
}

const CALLBACK_PATH = "/callback";
const DONE_PAGE =
  "<!doctype html><title>pw-support</title><p>Login complete. You can close this tab.</p>";
const FAILED_PAGE =
  "<!doctype html><title>pw-support</title><p>Login failed. Return to the terminal.</p>";

export async function loopbackLogin(options: LoopbackOptions) {
  const { config } = options;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? systemClock;
  const endpoints = await discover(config.issuer, fetcher);
  const pkce = await createPkce();

  let settle: (result: { code: string } | { error: string }) => void = () => {};
  const callback = new Promise<{ code: string } | { error: string }>(
    (resolve) => {
      settle = resolve;
    },
  );
  const server = Bun.serve({
    port: config.loginPort,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== CALLBACK_PATH) {
        return new Response("not found", { status: 404 });
      }
      const html = { "Content-Type": "text/html; charset=utf-8" };
      if (url.searchParams.get("state") !== pkce.state) {
        return new Response(FAILED_PAGE, { status: 400, headers: html });
      }
      const code = url.searchParams.get("code");
      if (!code) {
        settle({ error: url.searchParams.get("error") ?? "no_code" });
        return new Response(FAILED_PAGE, { status: 400, headers: html });
      }
      settle({ code });
      return new Response(DONE_PAGE, { headers: html });
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}${CALLBACK_PATH}`;
  const timer = setTimeout(
    () => settle({ error: "timeout" }),
    options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
  );
  try {
    await options.openUrl(
      buildAuthorizeUrl({
        endpoint: endpoints.authorization_endpoint,
        clientId: config.clientId,
        redirectUri,
        scope: config.scope,
        state: pkce.state,
        challenge: pkce.challenge,
      }),
    );
    const outcome = await callback;
    if ("error" in outcome)
      throw new LoginError(`login failed: ${outcome.error}`);
    const tokens = await tokenRequest(
      endpoints.token_endpoint,
      {
        grant_type: "authorization_code",
        code: outcome.code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        code_verifier: pkce.verifier,
      },
      fetcher,
      config,
      now,
    );
    const stored: StoredTokens = {
      ...tokens,
      issuer: config.issuer,
      clientId: config.clientId,
      grant: "authorization_code",
    };
    options.store.write(stored);
    return stored;
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}

export async function clientCredentialsLogin(options: {
  config: PluginConfig;
  store: TokenStore;
  fetcher?: Fetcher;
  now?: Clock;
}) {
  const { config } = options;
  if (!config.clientSecret) {
    throw new LoginError("a client secret is required");
  }
  const fetcher = options.fetcher ?? fetch;
  const endpoints = await discover(config.issuer, fetcher);
  const tokens = await tokenRequest(
    endpoints.token_endpoint,
    {
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope:
        config.scope === "openid email profile"
          ? config.clientId
          : config.scope,
    },
    fetcher,
    config,
    options.now ?? systemClock,
  );
  const stored: StoredTokens = {
    ...tokens,
    issuer: config.issuer,
    clientId: config.clientId,
    grant: "client_credentials",
  };
  options.store.write(stored);
  return stored;
}

export interface AccessTokenOptions {
  config: PluginConfig;
  store: TokenStore;
  fetcher?: Fetcher;
  now?: Clock;
  minValiditySeconds?: number;
}

function stillValid(
  tokens: StoredTokens,
  now: Clock,
  minValiditySeconds: number,
): boolean {
  return tokens.expiresAt - minValiditySeconds > Math.floor(now() / 1000);
}

export async function getAccessToken(
  options: AccessTokenOptions,
): Promise<string> {
  const { config, store } = options;
  const now = options.now ?? systemClock;
  const minimum = Math.max(
    EXPIRY_SKEW_SECONDS,
    options.minValiditySeconds ?? 0,
  );
  const stored = store.read();
  if (
    !stored ||
    stored.issuer !== config.issuer ||
    stored.clientId !== config.clientId
  ) {
    throw new NotLoggedInError();
  }
  if (stillValid(stored, now, minimum)) return stored.accessToken;
  const fetcher = options.fetcher ?? fetch;
  try {
    if (stored.grant === "client_credentials") {
      const renewed = await clientCredentialsLogin({
        config,
        store,
        fetcher,
        now,
      });
      return renewed.accessToken;
    }
    if (!stored.refreshToken)
      throw new NotLoggedInError(
        `session expired; run the login command: ${cliCommand("login")}`,
      );
    const endpoints = await discover(config.issuer, fetcher);
    const tokens = await tokenRequest(
      endpoints.token_endpoint,
      {
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        client_id: config.clientId,
      },
      fetcher,
      config,
      now,
    );
    const renewed: StoredTokens = {
      ...stored,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? stored.refreshToken,
      expiresAt: tokens.expiresAt,
    };
    store.write(renewed);
    return renewed.accessToken;
  } catch (error) {
    const latest = store.read();
    if (latest && stillValid(latest, now, minimum)) return latest.accessToken;
    if (error instanceof NotLoggedInError) throw error;
    throw new NotLoggedInError(
      `session refresh failed; run the login command: ${cliCommand("login")}`,
    );
  }
}
