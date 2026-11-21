import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

export const E2E = {
  apiPort: 8788,
  appPort: 5174,
  projectKey: "pk_e2e_acme_portal",
  projectSlug: "e2e",
  clientSlug: "acme",
} as const;

const apiUrl = `http://127.0.0.1:${E2E.apiPort}`;
const appUrl = `http://127.0.0.1:${E2E.appPort}`;

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
      command: "bun scripts/seed-dev.ts && bun modules/api/src/server.ts",
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
