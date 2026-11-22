import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTokenValidator, parseBearer } from "./auth";
import {
  otherSigningKey,
  startTestIssuer,
  TEST_AUDIENCE,
  type TestIssuer,
} from "./testing/oidc";

let idp: TestIssuer;

beforeAll(async () => {
  idp = await startTestIssuer();
});

afterAll(() => {
  idp.stop();
});

function validator(overrides: Parameters<TestIssuer["authConfig"]>[0] = {}) {
  const rejections: string[] = [];
  const instance = createTokenValidator(idp.authConfig(overrides), {
    onReject: (reason) => rejections.push(reason),
  });
  return { instance, rejections };
}

describe("parseBearer", () => {
  test("extracts a bearer token and rejects everything else", () => {
    expect(parseBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(parseBearer("bearer abc")).toBe("abc");
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("Bearer a b")).toBeNull();
    expect(parseBearer(`Bearer ${"x".repeat(9000)}`)).toBeNull();
  });
});

describe("token validator", () => {
  test("A19: accepts a valid token and extracts the staff identity", async () => {
    const { instance } = validator();
    const result = await instance.verify(await idp.token());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toEqual({
        sub: "staff-1",
        email: "ada@pressw.test",
        name: "Ada Admin",
      });
    }
  });

  test("A19: rejects the wrong issuer", async () => {
    const { instance, rejections } = validator();
    const token = await idp.token({ issuer: "https://evil.example/idp" });
    expect((await instance.verify(token)).ok).toBe(false);
    expect(rejections[0]).toContain("verify_failed");
  });

  test("A19: rejects the wrong audience", async () => {
    const { instance, rejections } = validator();
    const token = await idp.token({ claims: { aud: "another-client" } });
    expect((await instance.verify(token)).ok).toBe(false);
    expect(rejections).toEqual(["audience"]);
  });

  test("A19: rejects an expired token and a token that is not yet valid", async () => {
    const { instance } = validator();
    expect(
      (await instance.verify(await idp.token({ expiresIn: "-2m" }))).ok,
    ).toBe(false);
    expect(
      (await instance.verify(await idp.token({ notBefore: "1h" }))).ok,
    ).toBe(false);
  });

  test("accepts a token that expired inside the clock skew", async () => {
    const { instance } = validator({ clockToleranceSeconds: 30 });
    expect(
      (await instance.verify(await idp.token({ expiresIn: "-5s" }))).ok,
    ).toBe(true);
  });

  test("A19: rejects alg none", async () => {
    const { instance } = validator();
    expect((await instance.verify(idp.unsignedToken())).ok).toBe(false);
  });

  test("A19: rejects HS256 signed with the public key", async () => {
    const { instance } = validator();
    expect((await instance.verify(await idp.hmacToken())).ok).toBe(false);
  });

  test("A19: rejects an unknown kid and a signature from another key", async () => {
    const { instance } = validator();
    expect((await instance.verify(await idp.token({ kid: "ghost" }))).ok).toBe(
      false,
    );
    const forged = await idp.token({ signWith: await otherSigningKey() });
    expect((await instance.verify(forged)).ok).toBe(false);
  });

  test("A19: rejects a token without exp or sub", async () => {
    const { instance } = validator();
    expect((await instance.verify(await idp.token({ omit: ["sub"] }))).ok).toBe(
      false,
    );
  });

  test("rejects garbage and an oversized token", async () => {
    const { instance, rejections } = validator();
    expect((await instance.verify("not-a-jwt")).ok).toBe(false);
    expect((await instance.verify("")).ok).toBe(false);
    expect((await instance.verify("x".repeat(9000))).ok).toBe(false);
    expect(rejections.filter((reason) => reason === "malformed")).toHaveLength(
      2,
    );
  });

  test("fails closed while the JWKS endpoint is down and recovers", async () => {
    const { instance } = validator();
    const token = await idp.token();
    idp.failing(true);
    expect((await instance.verify(token)).ok).toBe(false);
    idp.failing(false);
    expect((await instance.verify(token)).ok).toBe(true);
  });

  test("fails closed when the JWKS endpoint is unreachable", async () => {
    const { instance } = validator({ issuer: "http://127.0.0.1:1/idp" });
    expect((await instance.verify(await idp.token())).ok).toBe(false);
  });

  test("rejects a discovery document that names another issuer", async () => {
    const fetcher = (async (url: string) => {
      if (String(url).endsWith("openid-configuration")) {
        return Response.json({
          issuer: "https://other.example",
          jwks_uri: `${idp.issuer}/jwks`,
        });
      }
      return fetch(url);
    }) as unknown as typeof fetch;
    const instance = createTokenValidator(idp.authConfig(), { fetcher });
    expect((await instance.verify(await idp.token())).ok).toBe(false);
  });

  test("accepts a Cognito access token that carries client_id", async () => {
    const { instance } = validator();
    const token = await idp.token({
      omit: ["aud", "email", "name"],
      claims: {
        client_id: TEST_AUDIENCE,
        token_use: "access",
        username: "ada",
      },
    });
    const result = await instance.verify(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toEqual({
        sub: "staff-1",
        email: null,
        name: "ada",
      });
    }
  });

  test("accepts any configured audience in an aud array", async () => {
    const { instance } = validator({ audiences: ["a", TEST_AUDIENCE] });
    const token = await idp.token({ claims: { aud: ["x", TEST_AUDIENCE] } });
    expect((await instance.verify(token)).ok).toBe(true);
  });

  test("rejects a client_id that does not match and an unknown token_use", async () => {
    const { instance } = validator();
    const wrongClient = await idp.token({
      omit: ["aud"],
      claims: { client_id: "other" },
    });
    expect((await instance.verify(wrongClient)).ok).toBe(false);
    const noAudience = await idp.token({ omit: ["aud"] });
    expect((await instance.verify(noAudience)).ok).toBe(false);
    const badUse = await idp.token({ claims: { token_use: "refresh" } });
    expect((await instance.verify(badUse)).ok).toBe(false);
  });

  test("enforces the optional email domain and group checks", async () => {
    const domain = validator({ allowedEmailDomains: ["pressw.test"] });
    expect((await domain.instance.verify(await idp.token())).ok).toBe(true);
    const outsider = await idp.token({ claims: { email: "x@other.test" } });
    expect((await domain.instance.verify(outsider)).ok).toBe(false);
    const noEmail = await idp.token({ omit: ["email"] });
    expect((await domain.instance.verify(noEmail)).ok).toBe(false);
    const group = validator({ requiredGroup: "staff" });
    const member = await idp.token({
      claims: { "cognito:groups": ["staff", "x"] },
    });
    expect((await group.instance.verify(member)).ok).toBe(true);
    expect((await group.instance.verify(await idp.token())).ok).toBe(false);
  });

  test("separates a permitted-identity failure (403) from an invalid token (401)", async () => {
    const policy = validator({
      allowedEmailDomains: ["pressw.test"],
      requiredGroup: "staff",
    });
    const kindOf = async (token: string) => {
      const result = await policy.instance.verify(token);
      return result.ok ? "ok" : result.kind;
    };
    const member = { "cognito:groups": ["staff"] };
    expect(await kindOf(await idp.token({ claims: member }))).toBe("ok");
    const outsider = { email: "x@other.test", ...member };
    expect(await kindOf(await idp.token({ claims: outsider }))).toBe(
      "forbidden",
    );
    expect(
      await kindOf(await idp.token({ omit: ["email"], claims: member })),
    ).toBe("forbidden");
    expect(await kindOf(await idp.token())).toBe("forbidden");
    expect(await kindOf(await idp.token({ issuer: "https://evil.test" }))).toBe(
      "unauthenticated",
    );
    expect(await kindOf(await idp.token({ claims: { aud: "other" } }))).toBe(
      "unauthenticated",
    );
    expect(await kindOf(await idp.token({ expiresIn: -60 }))).toBe(
      "unauthenticated",
    );
    expect(await kindOf(idp.unsignedToken())).toBe("unauthenticated");
    expect(await kindOf("garbage")).toBe("unauthenticated");
  });

  test("an invalid token never reaches the policy checks", async () => {
    const policy = validator({ allowedEmailDomains: ["pressw.test"] });
    const result = await policy.instance.verify(
      await idp.token({
        claims: { aud: "other", email: "x@other.test" },
      }),
    );
    expect(!result.ok && result.kind).toBe("unauthenticated");
  });

  test("fails closed without an issuer or an audience", async () => {
    for (const overrides of [{ issuer: undefined }, { audiences: [] }]) {
      const { instance, rejections } = validator(overrides);
      expect(instance.configured).toBe(false);
      expect((await instance.verify(await idp.token())).ok).toBe(false);
      expect(rejections).toEqual(["not_configured"]);
    }
  });

  test("caches the key set between verifications", async () => {
    const { instance } = validator();
    const before = idp.jwksHits();
    await instance.verify(await idp.token());
    await instance.verify(await idp.token());
    expect(idp.jwksHits() - before).toBe(1);
  });
});
