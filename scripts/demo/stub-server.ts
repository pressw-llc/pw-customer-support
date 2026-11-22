import { startLinearStub } from "@pw-support/channels/testing";
import { handleViewerRequest } from "./viewer";

const stubPort = Number(process.env.DEMO_STUB_PORT);
const viewerPort = Number(process.env.DEMO_VIEWER_PORT);
const apiPort = Number(process.env.DEMO_API_PORT);
const secret = process.env.LINEAR_WEBHOOK_SECRET as string;

const stub = startLinearStub({ port: stubPort });
stub.configureWebhook({
  url: `http://127.0.0.1:${apiPort}/webhooks/linear`,
  secret,
});

Bun.serve({
  port: viewerPort,
  hostname: "127.0.0.1",
  fetch: (request) => handleViewerRequest(stub, request),
});
console.log(
  `[stub] Linear stub ${stub.url}, viewer http://127.0.0.1:${viewerPort}`,
);
