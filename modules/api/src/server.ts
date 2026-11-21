import {
  createManagedSecrets,
  createSecretsManagerClient,
  createSecretWriter,
} from "@pw-support/channels";
import { loadTimingConfig, RESOURCE_NAMES } from "@pw-support/contracts";
import { createDb } from "@pw-support/db";
import { createApp } from "./app";
import { createTokenValidator } from "./auth";
import { loadConfig } from "./config";
import { createS3Storage } from "./storage";
import { createSqsClient, createSqsWakeSender } from "./wake";

const config = loadConfig();
const db = createDb();
const secretsClient = createSecretsManagerClient();
const validator = createTokenValidator(config.auth, {
  onReject: (reason) => {
    if (reason === "not_configured") console.error("[auth] not configured");
  },
});
if (!validator.configured) {
  console.error(
    "[auth] COGNITO_ISSUER and COGNITO_AUDIENCE are not set; /admin rejects every request",
  );
}
const app = createApp({
  db,
  validator,
  secretWriter: createSecretWriter(secretsClient),
  secrets: createManagedSecrets({
    db,
    client: secretsClient,
    scope: config.secretsScope,
  }),
  storage: createS3Storage(config),
  config,
  timing: loadTimingConfig(),
  wake: createSqsWakeSender({
    client: createSqsClient(),
    queueName: process.env.TRIAGE_WAKE_QUEUE || RESOURCE_NAMES.triageWakeQueue,
  }),
});

Bun.serve({
  port: config.port,
  maxRequestBodySize: config.maxBodyBytes,
  fetch: app.fetch,
});
console.log(`[api] listening on ${config.port}`);
