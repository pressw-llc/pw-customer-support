import {
  SUPPORT_KEY_HEADER,
  SUPPORT_USER_HEADER,
  type TriageTiming,
  type WakeSender,
} from "@pw-support/contracts";
import type { SupportDb } from "@pw-support/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ApiConfig } from "./config";
import {
  type Checks,
  createIntakeService,
  type InboundInput,
  type IntakeService,
  ProcessingError,
} from "./intake-service";
import { type IntakeEnv, identify, rateLimit } from "./middleware";
import type { ObjectStorage } from "./storage";

export interface AppDeps {
  db: SupportDb;
  storage: ObjectStorage;
  config: ApiConfig;
  checks?: Checks;
  wake?: WakeSender;
  timing?: TriageTiming;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readInbound(request: Request): Promise<InboundInput | null> {
  const form = await request.formData().catch(() => null);
  if (!form) return null;
  const text = form.get("text");
  if (typeof text !== "string" || text.trim() === "") return null;
  const files = form
    .getAll("files")
    .filter((value) => typeof value !== "string") as unknown as File[];
  return { text, files };
}

function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function intakeRoutes(service: IntakeService) {
  const routes = new Hono<IntakeEnv>();

  routes.post("/requests", async (c) => {
    const input = await readInbound(c.req.raw);
    if (!input) return c.json({ error: "text_required" }, 400);
    return c.json(await service.createRequest(c.get("scope"), input), 201);
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
    const input = await readInbound(c.req.raw);
    if (!input) return c.json({ error: "text_required" }, 400);
    const result = UUID.test(id)
      ? await service.addMessage(c.get("scope"), id, input)
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
