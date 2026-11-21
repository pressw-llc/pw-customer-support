import { createDb } from "@pw-support/db";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createS3Storage } from "./storage";

const config = loadConfig();
const app = createApp({
  db: createDb(),
  storage: createS3Storage(config),
  config,
});

Bun.serve({
  port: config.port,
  maxRequestBodySize: config.maxBodyBytes,
  fetch: app.fetch,
});
console.log(`[api] listening on ${config.port}`);
