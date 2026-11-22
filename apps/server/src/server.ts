import {
  createApp,
  createS3Storage,
  createSqsClient,
  createSqsWakeSender,
  createTokenValidator,
  loadConfig,
  mcpAuthConfig,
  productionWarnings,
} from "@pw-support/api";
import {
  createLinearWebhookIntake,
  createManagedSecrets,
  createSecretsManagerClient,
  createSecretWriter,
} from "@pw-support/channels";
import { loadTimingConfig, RESOURCE_NAMES } from "@pw-support/contracts";
import { createDb } from "@pw-support/db";
import {
  createLaptopBackend,
  jevFromSecrets,
  loadTriageConfig,
  runExtractionSelfTest,
} from "@pw-support/triage";

await runExtractionSelfTest();
console.log("[api] extraction self-test passed");
const config = loadConfig();
for (const warning of productionWarnings(config)) {
  console.warn(`[config] ${warning}`);
}
const db = createDb();
const secretsClient = createSecretsManagerClient();
const validator = createTokenValidator(config.auth, {
  onReject: (reason) => {
    if (reason === "not_configured") console.error("[auth] not configured");
  },
});
const mcpValidator = createTokenValidator(mcpAuthConfig(config), {
  onReject: (reason) => {
    if (reason === "not_configured") console.error("[mcp] not configured");
  },
});
if (!validator.configured) {
  console.error(
    "[auth] COGNITO_ISSUER and COGNITO_AUDIENCE are not set; /admin and /mcp reject every request",
  );
}
const secrets = createManagedSecrets({
  db,
  client: secretsClient,
  scope: config.secretsScope,
});
const storage = createS3Storage(config);
const timing = loadTimingConfig();
const triageConfig = loadTriageConfig();
const wake = createSqsWakeSender({
  client: createSqsClient(),
  queueName: process.env.TRIAGE_WAKE_QUEUE || RESOURCE_NAMES.triageWakeQueue,
});
const app = createApp({
  db,
  validator,
  mcpValidator,
  secretWriter: createSecretWriter(secretsClient),
  secrets,
  storage,
  config,
  linearWebhook: createLinearWebhookIntake({ db, secrets }),
  timing,
  wake,
  laptop: createLaptopBackend({
    db,
    storage,
    jev: jevFromSecrets(triageConfig, secrets),
    config: triageConfig,
    wake,
    log: (message, detail) =>
      console.log(`[laptop] ${message}`, detail ? JSON.stringify(detail) : ""),
  }),
});

Bun.serve({
  port: config.port,
  maxRequestBodySize: config.maxBodyBytes,
  fetch: app.fetch,
});
console.log(`[api] listening on ${config.port}`);
