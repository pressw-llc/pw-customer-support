import { loadTimingConfig, RESOURCE_NAMES } from "@pw-support/contracts";
import { createDb } from "@pw-support/db";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createS3Storage } from "./storage";
import { createSqsClient, createSqsWakeSender } from "./wake";

const config = loadConfig();
const app = createApp({
  db: createDb(),
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
