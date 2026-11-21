import { createApp } from "./app";

Bun.serve({
  port: Number(process.env.API_PORT ?? 8787),
  fetch: createApp().fetch,
});
