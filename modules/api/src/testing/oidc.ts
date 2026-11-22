import {
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import type { AuthConfig } from "../auth";

export const TEST_AUDIENCE = "pw-support-test-client";

export interface TokenOptions {
  claims?: Record<string, unknown>;
  kid?: string;
  issuer?: string;
  expiresIn?: string | number;
  notBefore?: string | number;
  signWith?: CryptoKey;
  omit?: string[];
}

export interface TestIssuer {
  issuer: string;
  jwksHits(): number;
  authConfig(overrides?: Partial<AuthConfig>): AuthConfig;
  token(options?: TokenOptions): Promise<string>;
  unsignedToken(): string;
  hmacToken(): Promise<string>;
  failing(value: boolean): void;
  stop(): void;
}

const KID = "test-key-1";

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function startTestIssuer(): Promise<TestIssuer> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk: JWK = {
    ...(await exportJWK(pair.publicKey)),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };
  let fail = false;
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request): Response {
      const { pathname } = new URL(request.url);
      if (fail) return new Response("down", { status: 503 });
      if (pathname === "/idp/.well-known/openid-configuration") {
        return Response.json({
          issuer: issuer(),
          jwks_uri: `${issuer()}/jwks`,
        });
      }
      if (pathname === "/idp/jwks") {
        hits += 1;
        return Response.json({ keys: [publicJwk] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const issuer = (): string => `http://127.0.0.1:${server.port}/idp`;

  async function token(options: TokenOptions = {}): Promise<string> {
    const claims: Record<string, unknown> = {
      sub: "staff-1",
      aud: TEST_AUDIENCE,
      email: "ada@pressw.test",
      name: "Ada Admin",
      ...options.claims,
    };
    for (const name of options.omit ?? []) delete claims[name];
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: options.kid ?? KID })
      .setIssuer(options.issuer ?? issuer())
      .setIssuedAt()
      .setNotBefore(options.notBefore ?? "0s")
      .setExpirationTime(options.expiresIn ?? "5m");
    return jwt.sign(options.signWith ?? pair.privateKey);
  }

  return {
    get issuer() {
      return issuer();
    },
    jwksHits: () => hits,
    authConfig: (overrides = {}) => ({
      issuer: issuer(),
      audiences: [TEST_AUDIENCE],
      allowedEmailDomains: [],
      requiredGroup: undefined,
      clockToleranceSeconds: 5,
      fetchTimeoutMs: 1000,
      ...overrides,
    }),
    token,
    unsignedToken: () =>
      `${base64url({ alg: "none", typ: "JWT" })}.${base64url({
        iss: issuer(),
        sub: "attacker",
        aud: TEST_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 300,
      })}.`,
    async hmacToken() {
      return new SignJWT({ sub: "attacker", aud: TEST_AUDIENCE })
        .setProtectedHeader({ alg: "HS256", kid: KID })
        .setIssuer(issuer())
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode(JSON.stringify(publicJwk)));
    },
    failing(value) {
      fail = value;
    },
    stop() {
      server.stop(true);
    },
  };
}

export async function otherSigningKey(): Promise<CryptoKey> {
  return (await generateKeyPair("RS256")).privateKey;
}
