import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_API_URL, defaultConfigDir, loadPluginConfig } from "./config";
import { challengeFor, createPkce, randomToken } from "./pkce";
import { createFileTokenStore, TOKEN_FILE } from "./token-store";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pw-support-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tokens = {
  issuer: "https://idp.test",
  clientId: "c",
  grant: "authorization_code" as const,
  accessToken: "a",
  refreshToken: "r",
  expiresAt: 5,
};

describe("token store", () => {
  test("writes a private file and reads it back", () => {
    const store = createFileTokenStore(join(dir, "nested"));
    expect(store.read()).toBeNull();
    store.write(tokens);
    expect(store.read()).toEqual(tokens);
    const file = join(dir, "nested", TOKEN_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    store.write({ ...tokens, accessToken: "b" });
    expect(store.read()?.accessToken).toBe("b");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("treats a damaged or invalid file as logged out", () => {
    const store = createFileTokenStore(dir);
    writeFileSync(join(dir, TOKEN_FILE), "{not json");
    expect(store.read()).toBeNull();
    writeFileSync(join(dir, TOKEN_FILE), JSON.stringify({ accessToken: "" }));
    expect(store.read()).toBeNull();
  });

  test("clears the file and repairs loose permissions on rewrite", () => {
    const store = createFileTokenStore(dir);
    store.write(tokens);
    const file = join(dir, TOKEN_FILE);
    chmodSync(file, 0o644);
    store.write(tokens);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain('"accessToken":"a"');
    store.clear();
    expect(store.read()).toBeNull();
    store.clear();
  });
});

describe("pkce", () => {
  test("matches the RFC 7636 test vector", async () => {
    expect(
      await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("creates a verifier of valid length, a matching challenge, and unique state", async () => {
    const first = await createPkce();
    const second = await createPkce();
    expect(first.verifier.length).toBeGreaterThanOrEqual(43);
    expect(first.verifier.length).toBeLessThanOrEqual(128);
    expect(first.challenge).toBe(await challengeFor(first.verifier));
    expect(first.state).not.toBe(second.state);
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("plugin config", () => {
  test("applies defaults and overrides", () => {
    const config = loadPluginConfig({ XDG_CONFIG_HOME: "/x" });
    expect(config.apiUrl).toBe(DEFAULT_API_URL);
    expect(config.configDir).toBe("/x/pw-support");
    expect(config.issuer).toBe("http://127.0.0.1:4599/support");
    expect(config.clientId).toBe("pw-support-mcp");
    expect(config.maxTurns).toBe(3);
    const custom = loadPluginConfig({
      PW_SUPPORT_API_URL: "https://api.test/",
      PW_SUPPORT_ISSUER: "https://idp.test/",
      PW_SUPPORT_RUN_TIMEOUT_SECONDS: "30",
      PW_SUPPORT_MODEL: "m",
      PW_SUPPORT_CONFIG_DIR: "/c",
      PW_SUPPORT_LOGIN_PORT: "bad",
    });
    expect(custom.apiUrl).toBe("https://api.test");
    expect(custom.issuer).toBe("https://idp.test");
    expect(custom.runTimeoutSeconds).toBe(30);
    expect(custom.model).toBe("m");
    expect(custom.configDir).toBe("/c");
    expect(custom.loginPort).toBe(53682);
    expect(defaultConfigDir({})).toContain("pw-support");
  });
});
