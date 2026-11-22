import {
  createSecretsManagerClient,
  createSecretWriter,
  type LinearWebhookIntake,
  type ManagedSecrets,
  type SecretWriter,
} from "@pw-support/channels";
import {
  defaultTiming,
  LINEAR_DELIVERY_HEADER,
  LINEAR_SIGNATURE_HEADER,
  LINEAR_WEBHOOK_MAX_BYTES,
  SUPPORT_KEY_HEADER,
  SUPPORT_USER_HEADER,
  type TriageTiming,
  type WakeSender,
} from "@pw-support/contracts";
import type { SupportDb } from "@pw-support/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { adminRoutes } from "./admin";
import { createTokenValidator, type TokenValidator } from "./auth";
import { type ApiConfig, mcpAuthConfig } from "./config";
import {
  type Checks,
  createIntakeService,
  type InboundInput,
  type IntakeService,
  ProcessingError,
} from "./intake-service";
import { type LaptopBackend, mcpRoutes } from "./mcp";
import { MAX_TEXT_FIELD_BYTES } from "./message-checks";
import { type IntakeEnv, identify, rateLimit } from "./middleware";
import type { ObjectStorage } from "./storage";

export interface AppDeps {
  db: SupportDb;
  storage: ObjectStorage;
  config: ApiConfig;
  checks?: Checks;
  wake?: WakeSender;
  validator?: TokenValidator;
  mcpValidator?: TokenValidator;
  laptop?: LaptopBackend;
  secretWriter?: SecretWriter;
  secrets?: Pick<ManagedSecrets, "invalidate">;
  timing?: TriageTiming;
  linearWebhook?: LinearWebhookIntake;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InboundRead =
  | { ok: true; input: InboundInput }
  | { ok: false; status: 400 | 413; error: string };

const TEXT_REQUIRED: InboundRead = {
  ok: false,
  status: 400,
  error: "text_required",
};

async function readInbound(request: Request): Promise<InboundRead> {
  const form = await request.formData().catch(() => null);
  if (!form) return TEXT_REQUIRED;
  const text = form.get("text");
  if (typeof text !== "string") return TEXT_REQUIRED;
  if (Buffer.byteLength(text) > MAX_TEXT_FIELD_BYTES) {
    return { ok: false, status: 413, error: "payload_too_large" };
  }
  if (text.trim() === "") return TEXT_REQUIRED;
  const files = form
    .getAll("files")
    .filter((value) => typeof value !== "string") as unknown as File[];
  return { ok: true, input: { text, files } };
}

function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function intakeRoutes(service: IntakeService) {
  const routes = new Hono<IntakeEnv>();

  routes.post("/requests", async (c) => {
    const read = await readInbound(c.req.raw);
    if (!read.ok) return c.json({ error: read.error }, read.status);
    return c.json(await service.createRequest(c.get("scope"), read.input), 201);
  });

  routes.get("/requests", async (c) =>
    c.json(await service.listRequests(c.get("scope"))),
  );

  routes.get("/requests/:id", async (c) => {
    const id = c.req.param("id");
    const thread = UUID.test(id)
      ? await service.getThread(c.get("scope"), id)
      : null;
    return thread ? c.json(thread) : c.json({ error: "not_found" }, 404);
  });

  routes.post("/requests/:id/messages", async (c) => {
    const id = c.req.param("id");
    const read = await readInbound(c.req.raw);
    if (!read.ok) return c.json({ error: read.error }, read.status);
    const result = UUID.test(id)
      ? await service.addMessage(c.get("scope"), id, read.input)
      : null;
    return result ? c.json(result, 201) : c.json({ error: "not_found" }, 404);
  });

  routes.post("/requests/:id/read", async (c) => {
    const id = c.req.param("id");
    const found = UUID.test(id) && (await service.markRead(c.get("scope"), id));
    return found ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  routes.get("/attachments/:id", async (c) => {
    const id = c.req.param("id");
    const opened = UUID.test(id)
      ? await service.openAttachment(c.get("scope"), id)
      : null;
    if (!opened) return c.json({ error: "not_found" }, 404);
    return new Response(opened.object.stream, {
      headers: {
        "Content-Type": opened.row.contentType,
        "Content-Length": String(opened.row.sizeBytes),
        "Content-Disposition": contentDisposition(opened.row.filename),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });

  return routes;
}

export function createApp(deps: AppDeps): Hono {
  const service = createIntakeService(deps);
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.use(
    "/v1/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", SUPPORT_KEY_HEADER, SUPPORT_USER_HEADER],
      exposeHeaders: ["Retry-After", "Content-Disposition"],
      maxAge: 600,
    }),
    bodyLimit({
      maxSize: deps.config.maxBodyBytes,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
    identify(deps.db),
    rateLimit(deps.db, deps.config.rateLimit),
  );
  app.route("/v1", intakeRoutes(service));

  app.post(
    "/webhooks/linear",
    bodyLimit({
      maxSize: LINEAR_WEBHOOK_MAX_BYTES,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
    async (c) => {
      if (!deps.linearWebhook) {
        return c.json({ error: "webhook_not_configured" }, 503);
      }
      const result = await deps.linearWebhook.handle({
        rawBody: new Uint8Array(await c.req.arrayBuffer()),
        signature: c.req.header(LINEAR_SIGNATURE_HEADER),
        delivery: c.req.header(LINEAR_DELIVERY_HEADER),
      });
      return c.json(result.body, result.status);
    },
  );

  const validator =
    deps.validator ??
    createTokenValidator(deps.config.auth, {
      onReject: (reason) => {
        if (reason === "not_configured") console.error("[auth] not configured");
      },
    });
  app.route(
    "/",
    mcpRoutes({
      db: deps.db,
      validator:
        deps.mcpValidator ??
        deps.validator ??
        createTokenValidator(mcpAuthConfig(deps.config)),
      config: {
        ...deps.config.mcp,
        windowSeconds: deps.config.rateLimit.windowSeconds,
      },
      timing: deps.timing ?? defaultTiming,
      laptop: deps.laptop,
      wake: deps.wake,
      now: deps.now,
    }),
  );
  app.route(
    "/admin",
    adminRoutes({
      db: deps.db,
      storage: deps.storage,
      config: deps.config,
      validator,
      secretWriter:
        deps.secretWriter ?? createSecretWriter(createSecretsManagerClient()),
      secrets: deps.secrets,
    }),
  );

  app.onError((error, c) => {
    if (error instanceof ProcessingError) {
      console.error("inbound processing failed", error.cause);
      return c.json(
        { error: "processing_failed", requestId: error.requestId },
        500,
      );
    }
    console.error("unhandled error", error);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
