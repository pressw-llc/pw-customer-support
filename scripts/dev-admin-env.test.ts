import { expect, test } from "bun:test";
import { adminDevEnv } from "./dev-admin-env";

test("defaults the admin app to the local API and mock issuer", () => {
  const env = adminDevEnv({ SUPPORT_OIDC_PORT: "4594", API_PORT: "9000" });
  expect(env.VITE_API_URL).toBe("http://127.0.0.1:9000");
  expect(env.VITE_OIDC_AUTHORITY).toBe("http://127.0.0.1:4594/support");
  expect(env.VITE_OIDC_CLIENT_ID).toBe("pw-support-admin");
});

test("explicit values win and undefined entries are dropped", () => {
  const env = adminDevEnv({
    VITE_API_URL: "https://api.example",
    VITE_OIDC_AUTHORITY: "https://idp.example",
    VITE_OIDC_CLIENT_ID: "client",
    SKIPPED: undefined,
  });
  expect(env.VITE_API_URL).toBe("https://api.example");
  expect(env.VITE_OIDC_AUTHORITY).toBe("https://idp.example");
  expect(env.VITE_OIDC_CLIENT_ID).toBe("client");
  expect("SKIPPED" in env).toBe(false);
});

test("reads process.env by default", () => {
  expect(adminDevEnv().VITE_OIDC_AUTHORITY).toBeTruthy();
});
