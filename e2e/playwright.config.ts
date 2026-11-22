import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { LOCAL_OIDC_CLIENT_ID, resolveStackEnv } from "@pw-support/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

export const E2E = {
  apiPort: Number(process.env.E2E_API_PORT) || 8788,
  appPort: Number(process.env.E2E_APP_PORT) || 5174,
  adminPort: Number(process.env.E2E_ADMIN_PORT) || 5184,
  policyApiPort: Number(process.env.E2E_POLICY_API_PORT) || 8789,
  audienceApiPort: Number(process.env.E2E_AUDIENCE_API_PORT) || 8790,
  projectKey: "pk_e2e_acme_portal",
  projectSlug: "e2e",
  clientSlug: "acme",
  stubPort: Number(process.env.E2E_STUB_PORT) || 4591,
  controlPort: Number(process.env.E2E_CONTROL_PORT) || 4592,
  webhookSecret: "whsec_e2e_secret",
} as const;

const apiUrl = `http://127.0.0.1:${E2E.apiPort}`;
const appUrl = `http://127.0.0.1:${E2E.appPort}`;
const adminUrl = `http://127.0.0.1:${E2E.adminPort}`;
const issuer = resolveStackEnv(process.env).localIssuer;
const secretsScope = `e2e-${Date.now().toString(36)}`;

export const ADMIN = {
  url: adminUrl,
  apiUrl,
  policyApiUrl: `http://127.0.0.1:${E2E.policyApiPort}`,
  audienceApiUrl: `http://127.0.0.1:${E2E.audienceApiPort}`,
  allowedDomain: "pressw.test",
  issuer,
  clientId: LOCAL_OIDC_CLIENT_ID,
} as const;

function variantApi(port: number, env: Record<string, string>) {
  return {
    command: "bun apps/server/src/server.ts",
    cwd: root,
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      API_PORT: String(port),
      ADMIN_ORIGINS: adminUrl,
      SECRETS_SCOPE: secretsScope,
      COGNITO_ISSUER: issuer,
      COGNITO_AUDIENCE: LOCAL_OIDC_CLIENT_ID,
      ...env,
    },
  };
}

export default defineConfig({
  testDir: here,
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: resolve(here, "artifacts/results"),
  use: { baseURL: appUrl },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun scripts/seed-dev.ts && bun apps/server/src/server.ts",
      cwd: root,
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        API_PORT: String(E2E.apiPort),
        SEED_CLIENT_SLUG: E2E.clientSlug,
        SEED_PROJECT_SLUG: E2E.projectSlug,
        SEED_PROJECT_KEY: E2E.projectKey,
        RATE_LIMIT_PER_USER: "5000",
        RATE_LIMIT_PER_KEY: "50000",
        ADMIN_ORIGINS: adminUrl,
        SECRETS_SCOPE: secretsScope,
        COGNITO_ISSUER: issuer,
        COGNITO_AUDIENCE: LOCAL_OIDC_CLIENT_ID,
        LINEAR_WEBHOOK_SECRET: E2E.webhookSecret,
        TRIAGE_INITIAL_DELAY_SECONDS: "0",
      },
    },
    variantApi(E2E.policyApiPort, {
      ADMIN_ALLOWED_EMAIL_DOMAINS: ADMIN.allowedDomain,
    }),
    variantApi(E2E.audienceApiPort, { COGNITO_AUDIENCE: "another-client" }),
    {
      command: "bun scripts/stack-setup.ts && bun e2e/backend.ts",
      cwd: root,
      url: `http://127.0.0.1:${E2E.controlPort}/health`,
      reuseExistingServer: false,
      timeout: 90_000,
      env: {
        E2E_API_PORT: String(E2E.apiPort),
        E2E_STUB_PORT: String(E2E.stubPort),
        E2E_CONTROL_PORT: String(E2E.controlPort),
        LINEAR_WEBHOOK_SECRET: E2E.webhookSecret,
        SEED_CLIENT_SLUG: E2E.clientSlug,
        SEED_PROJECT_SLUG: E2E.projectSlug,
        SEED_PROJECT_KEY: E2E.projectKey,
        TRIAGE_SWEEP_INTERVAL_SECONDS: "1",
        TRIAGE_INITIAL_DELAY_SECONDS: "0",
        TRIAGE_INTAKE_GRACE_SECONDS: "2",
        TRIAGE_WORKER_ID: "e2e-worker",
      },
    },
    {
      command: "bunx vite",
      cwd: resolve(root, "modules/admin"),
      url: adminUrl,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ADMIN_DEV_PORT: String(E2E.adminPort),
        VITE_API_URL: apiUrl,
        VITE_OIDC_AUTHORITY: issuer,
        VITE_OIDC_CLIENT_ID: LOCAL_OIDC_CLIENT_ID,
      },
    },
    {
      command: `bunx vite --host 127.0.0.1 --port ${E2E.appPort} --strictPort`,
      cwd: resolve(root, "examples/host-app"),
      url: appUrl,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_SUPPORT_PROJECT_KEY: E2E.projectKey,
        VITE_SUPPORT_USER_EMAIL: "default@acme.test",
        VITE_SUPPORT_API_URL: apiUrl,
      },
    },
  ],
});
