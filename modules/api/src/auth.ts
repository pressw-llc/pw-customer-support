import type { StaffIdentity } from "@pw-support/contracts";
import {
  createRemoteJWKSet,
  customFetch,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { z } from "zod";

export interface AuthConfig {
  issuer: string | undefined;
  audiences: string[];
  allowedEmailDomains: string[];
  requiredGroup: string | undefined;
  clockToleranceSeconds: number;
  fetchTimeoutMs: number;
}

export type TokenResult =
  | { ok: true; identity: StaffIdentity; claims: JWTPayload }
  | { ok: false; reason: string; kind: RejectionKind };

export type RejectionKind = "unauthenticated" | "forbidden";

export interface TokenValidator {
  readonly configured: boolean;
  verify(token: string): Promise<TokenResult>;
}

export interface TokenValidatorOptions {
  fetcher?: typeof fetch;
  onReject?: (reason: string) => void;
}

const MAX_TOKEN_CHARS = 8192;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_CACHE_MS = 10 * 60 * 1000;
const JWKS_COOLDOWN_MS = 30 * 1000;
const TOKEN_USES = new Set(["id", "access"]);

const discoverySchema = z.object({ issuer: z.string(), jwks_uri: z.string() });

export function parseBearer(header: string | undefined): string | null {
  const match = header ? /^Bearer +(\S+)$/i.exec(header.trim()) : null;
  const token = match?.[1];
  return token && token.length <= MAX_TOKEN_CHARS ? token : null;
}

function asStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringClaim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" && value !== "" ? value : null;
}

function audienceMatches(payload: JWTPayload, audiences: string[]): boolean {
  const claimed =
    payload.aud === undefined
      ? asStrings(payload.client_id)
      : asStrings(payload.aud);
  return claimed.some((value) => audiences.includes(value));
}

function emailDomainAllowed(email: string | null, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const domain = email?.toLowerCase().split("@")[1];
  return domain !== undefined && domains.includes(domain);
}

function identityOf(payload: JWTPayload): StaffIdentity {
  return {
    sub: String(payload.sub),
    email: stringClaim(payload, "email"),
    name:
      stringClaim(payload, "name") ??
      stringClaim(payload, "cognito:username") ??
      stringClaim(payload, "username"),
  };
}

export function createTokenValidator(
  config: AuthConfig,
  options: TokenValidatorOptions = {},
): TokenValidator {
  const fetcher = options.fetcher ?? fetch;
  const issuer = config.issuer?.replace(/\/+$/, "");
  const configured = Boolean(issuer) && config.audiences.length > 0;
  let keys: { getKey: JWTVerifyGetKey; discoveredAt: number } | undefined;

  async function discover(base: string): Promise<JWTVerifyGetKey> {
    const response = await fetcher(`${base}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });
    if (!response.ok) throw new Error("discovery failed");
    const document = discoverySchema.parse(await response.json());
    if (document.issuer.replace(/\/+$/, "") !== base) {
      throw new Error("discovery issuer mismatch");
    }
    return createRemoteJWKSet(new URL(document.jwks_uri), {
      timeoutDuration: config.fetchTimeoutMs,
      cooldownDuration: JWKS_COOLDOWN_MS,
      cacheMaxAge: JWKS_CACHE_MS,
      [customFetch]: fetcher,
    });
  }

  async function keySet(base: string): Promise<JWTVerifyGetKey> {
    if (keys && Date.now() - keys.discoveredAt < DISCOVERY_TTL_MS) {
      return keys.getKey;
    }
    const getKey = await discover(base);
    keys = { getKey, discoveredAt: Date.now() };
    return getKey;
  }

  function reject(
    reason: string,
    kind: RejectionKind = "unauthenticated",
  ): TokenResult {
    options.onReject?.(reason);
    return { ok: false, reason, kind };
  }

  return {
    configured,
    async verify(token) {
      if (!issuer || !configured) return reject("not_configured");
      if (token.length === 0 || token.length > MAX_TOKEN_CHARS) {
        return reject("malformed");
      }
      let payload: JWTPayload;
      try {
        const getKey = await keySet(issuer);
        ({ payload } = await jwtVerify(token, getKey, {
          issuer,
          algorithms: ["RS256"],
          clockTolerance: config.clockToleranceSeconds,
          requiredClaims: ["exp", "sub"],
        }));
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        return reject(`verify_failed:${name}`);
      }
      const tokenUse = payload.token_use;
      if (tokenUse !== undefined && !TOKEN_USES.has(String(tokenUse))) {
        return reject("token_use");
      }
      if (!audienceMatches(payload, config.audiences)) {
        return reject("audience");
      }
      const identity = identityOf(payload);
      if (!emailDomainAllowed(identity.email, config.allowedEmailDomains)) {
        return reject("email_domain", "forbidden");
      }
      if (
        config.requiredGroup &&
        !asStrings(payload["cognito:groups"]).includes(config.requiredGroup)
      ) {
        return reject("group", "forbidden");
      }
      return { ok: true, identity, claims: payload };
    },
  };
}
