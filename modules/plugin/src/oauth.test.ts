import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig, type PluginConfig } from "./config";
import {
  buildAuthorizeUrl,
  clientCredentialsLogin,
  discover,
  getAccessToken,
  LoginError,
  loopbackLogin,
  NotLoggedInError,
} from "./oauth";
import { challengeFor } from "./pkce";
import { createFileTokenStore, type TokenStore } from "./token-store";

interface FakeIssuer {
  url: string;
  requests: { path: string; body: URLSearchParams }[];
  nextToken: { access: string; refresh?: string; expiresIn: number };
  failToken: boolean;
  stop(): void;
}

function startIssuer(): FakeIssuer {
  const issuer: FakeIssuer = {
    url: "",
    requests: [],
    nextToken: { access: "access-1", refresh: "refresh-1", expiresIn: 3600 },
    failToken: false,
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/idp/.well-known/openid-configuration") {
        return Response.json({
          issuer: issuer.url,
          authorization_endpoint: `${issuer.url}/authorize`,
          token_endpoint: `${issuer.url}/token`,
        });
      }
      if (pathname === "/idp/token") {
        const body = new URLSearchParams(await request.text());
        issuer.requests.push({ path: pathname, body });
        if (issuer.failToken) return new Response("no", { status: 400 });
        return Response.json({
          access_token: issuer.nextToken.access,
          refresh_token: issuer.nextToken.refresh,
          expires_in: issuer.nextToken.expiresIn,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  issuer.url = `http://127.0.0.1:${server.port}/idp`;
  issuer.stop = () => server.stop(true);
  return issuer;
}

let issuer: FakeIssuer;
let dir: string;
let config: PluginConfig;
let store: TokenStore;
let clock = 1_000_000_000_000;
const now = () => clock;

beforeEach(() => {
  issuer = startIssuer();
  dir = mkdtempSync(join(tmpdir(), "pw-support-oauth-"));
  clock = 1_000_000_000_000;
  config = {
    ...loadPluginConfig(
      {
        PW_SUPPORT_ISSUER: issuer.url,
        PW_SUPPORT_CONFIG_DIR: dir,
        PW_SUPPORT_CLIENT_ID: "client-1",
      },
      { loginPort: 0 },
    ),
  };
  store = createFileTokenStore(dir);
});

afterEach(() => {
  issuer.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function browse(url: string, overrides: Record<string, string> = {}) {
  const target = new URL(url);
  const redirect = new URL(target.searchParams.get("redirect_uri") as string);
  redirect.searchParams.set("code", "code-1");
  redirect.searchParams.set(
    "state",
    target.searchParams.get("state") as string,
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (value === "") redirect.searchParams.delete(key);
    else redirect.searchParams.set(key, value);
  }
  return fetch(redirect);
}

describe("discovery and urls", () => {
  test("discovers the endpoints and rejects an issuer mismatch", async () => {
    expect((await discover(issuer.url)).token_endpoint).toBe(
      `${issuer.url}/token`,
    );
    await expect(discover(`${issuer.url}/other`)).rejects.toBeInstanceOf(
      LoginError,
    );
    await expect(
      discover(`${issuer.url.replace("/idp", "")}/missing`),
    ).rejects.toBeInstanceOf(LoginError);
  });

  test("builds an authorize url with PKCE parameters", () => {
    const url = new URL(
      buildAuthorizeUrl({
        endpoint: "https://idp.test/authorize",
        clientId: "c",
        redirectUri: "http://127.0.0.1:1/callback",
        scope: "openid",
        state: "s",
        challenge: "ch",
      }),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
  });
});

describe("loopback login", () => {
  test("exchanges the code with a PKCE verifier and stores private tokens", async () => {
    let challenge = "";
    const tokens = await loopbackLogin({
      config,
      store,
      now,
      openUrl: async (url) => {
        challenge = new URL(url).searchParams.get("code_challenge") as string;
        const response = await browse(url);
        expect(response.status).toBe(200);
      },
    });
    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.expiresAt).toBe(1_000_000_000 + 3600);
    const exchange = issuer.requests[0]?.body;
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(await challengeFor(exchange?.get("code_verifier") as string)).toBe(
      challenge,
    );
    expect(exchange?.get("code")).toBe("code-1");
    expect(store.read()?.refreshToken).toBe("refresh-1");
    expect(statSync(join(dir, "tokens.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("ignores a callback with a wrong state and then accepts the real one", async () => {
    await loopbackLogin({
      config,
      store,
      now,
      openUrl: async (url) => {
        const bad = await browse(url, { state: "forged" });
        expect(bad.status).toBe(400);
        const good = await browse(url);
        expect(good.status).toBe(200);
      },
    });
    expect(issuer.requests).toHaveLength(1);
  });

  test("fails when the provider returns an error", async () => {
    await expect(
      loopbackLogin({
        config,
        store,
        now,
        openUrl: async (url) => {
          const target = new URL(url);
          const redirect = new URL(
            target.searchParams.get("redirect_uri") as string,
          );
          redirect.searchParams.set("error", "access_denied");
          redirect.searchParams.set(
            "state",
            target.searchParams.get("state") as string,
          );
          await fetch(redirect);
        },
      }),
    ).rejects.toThrow("access_denied");
    expect(store.read()).toBeNull();
  });

  test("fails on timeout and on an unknown path", async () => {
    await expect(
      loopbackLogin({
        config,
        store,
        now,
        timeoutMs: 50,
        openUrl: async (url) => {
          const target = new URL(url);
          const redirect = new URL(
            target.searchParams.get("redirect_uri") as string,
          );
          redirect.pathname = "/elsewhere";
          expect((await fetch(redirect)).status).toBe(404);
        },
      }),
    ).rejects.toThrow("timeout");
  });

  test("fails when the token endpoint refuses the code", async () => {
    issuer.failToken = true;
    await expect(
      loopbackLogin({ config, store, now, openUrl: (url) => void browse(url) }),
    ).rejects.toBeInstanceOf(LoginError);
  });
});

describe("client credentials", () => {
  test("requires a secret and stores a client credentials session", async () => {
    await expect(
      clientCredentialsLogin({ config, store, now }),
    ).rejects.toThrow("client secret");
    const withSecret = { ...config, clientSecret: "s3cret" };
    const tokens = await clientCredentialsLogin({
      config: withSecret,
      store,
      now,
    });
    expect(tokens.grant).toBe("client_credentials");
    const body = issuer.requests[0]?.body;
    expect(body?.get("grant_type")).toBe("client_credentials");
    expect(body?.get("scope")).toBe("client-1");
  });
});

describe("getAccessToken", () => {
  test("needs a stored session for this issuer and client", async () => {
    await expect(getAccessToken({ config, store, now })).rejects.toBeInstanceOf(
      NotLoggedInError,
    );
    store.write({
      issuer: "http://other",
      clientId: "client-1",
      grant: "authorization_code",
      accessToken: "x",
      expiresAt: 2_000_000_000,
    });
    await expect(getAccessToken({ config, store, now })).rejects.toBeInstanceOf(
      NotLoggedInError,
    );
  });

  test("returns a valid token without a network call", async () => {
    store.write({
      issuer: issuer.url,
      clientId: "client-1",
      grant: "authorization_code",
      accessToken: "still-good",
      refreshToken: "r",
      expiresAt: clock / 1000 + 3600,
    });
    expect(await getAccessToken({ config, store, now })).toBe("still-good");
    expect(issuer.requests).toHaveLength(0);
  });

  test("refreshes an expired token and keeps the refresh token", async () => {
    store.write({
      issuer: issuer.url,
      clientId: "client-1",
      grant: "authorization_code",
      accessToken: "old",
      refreshToken: "refresh-old",
      expiresAt: clock / 1000 - 10,
    });
    issuer.nextToken = { access: "fresh", expiresIn: 600 };
    expect(await getAccessToken({ config, store, now })).toBe("fresh");
    const request = issuer.requests[0]?.body;
    expect(request?.get("grant_type")).toBe("refresh_token");
    expect(request?.get("refresh_token")).toBe("refresh-old");
    expect(store.read()?.refreshToken).toBe("refresh-old");
  });

  test("refreshes early when a longer validity is required", async () => {
    store.write({
      issuer: issuer.url,
      clientId: "client-1",
      grant: "authorization_code",
      accessToken: "short",
      refreshToken: "r",
      expiresAt: clock / 1000 + 120,
    });
    issuer.nextToken = { access: "long", refresh: "r2", expiresIn: 3600 };
    expect(
      await getAccessToken({ config, store, now, minValiditySeconds: 300 }),
    ).toBe("long");
  });

  test("re-runs the client credentials grant when it expires", async () => {
    const withSecret = { ...config, clientSecret: "s3cret" };
    await clientCredentialsLogin({ config: withSecret, store, now });
    clock += 4000 * 1000;
    issuer.nextToken = { access: "renewed", expiresIn: 3600 };
    expect(await getAccessToken({ config: withSecret, store, now })).toBe(
      "renewed",
    );
  });

  test("asks for a new login when the refresh fails or no refresh token exists", async () => {
    store.write({
      issuer: issuer.url,
      clientId: "client-1",
      grant: "authorization_code",
      accessToken: "old",
      refreshToken: "r",
      expiresAt: clock / 1000 - 10,
    });
    issuer.failToken = true;
    await expect(getAccessToken({ config, store, now })).rejects.toBeInstanceOf(
      NotLoggedInError,
    );
    store.write({
      issuer: issuer.url,
      clientId: "client-1",
      grant: "authorization_code",
      accessToken: "old",
      expiresAt: clock / 1000 - 10,
    });
    await expect(getAccessToken({ config, store, now })).rejects.toThrow(
      "session expired",
    );
  });

  test("uses a token that another process refreshed during a failed refresh", async () => {
    store.write({
      issuer: issuer.url,
      clientId: "client-1",
      grant: "authorization_code",
      accessToken: "old",
      refreshToken: "r",
      expiresAt: clock / 1000 - 10,
    });
    issuer.failToken = true;
    const raced: TokenStore = {
      read: () => store.read(),
      write: (tokens) => store.write(tokens),
      clear: () => store.clear(),
    };
    const original = raced.read;
    let reads = 0;
    raced.read = () => {
      reads += 1;
      if (reads > 1) {
        return {
          issuer: issuer.url,
          clientId: "client-1",
          grant: "authorization_code",
          accessToken: "from-peer",
          expiresAt: clock / 1000 + 3600,
        };
      }
      return original();
    };
    expect(await getAccessToken({ config, store: raced, now })).toBe(
      "from-peer",
    );
  });
});
