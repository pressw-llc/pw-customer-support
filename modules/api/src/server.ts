import { createLinearWebhookIntake, envSecrets } from "@pw-support/channels";
import { loadTimingConfig, RESOURCE_NAMES } from "@pw-support/contracts";
import { createDb } from "@pw-support/db";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createS3Storage } from "./storage";
import { createSqsClient, createSqsWakeSender } from "./wake";

const config = loadConfig();
const db = createDb();
const app = createApp({
  db,
  storage: createS3Storage(config),
  config,
  linearWebhook: createLinearWebhookIntake({ db, secrets: envSecrets() }),
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
