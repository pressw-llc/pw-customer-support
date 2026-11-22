import type { ManagedSecrets, SecretWriter } from "@pw-support/channels";
import {
  adminRequestFiltersSchema,
  ccListInputSchema,
  createProjectInputSchema,
  INTEGRATIONS,
  integrationKindSchema,
  maskProjectKey,
  type StaffIdentity,
  saveIntegrationInputSchema,
  updateProjectInputSchema,
} from "@pw-support/contracts";
import {
  createAdminProject,
  getAdminAttachment,
  getAdminProject,
  getAdminRequestDetail,
  hitRateLimit,
  listAdminProjects,
  listAdminRequests,
  listIntegrations,
  mintProjectKey,
  recordIntegration,
  revokeProjectKey,
  type SupportDb,
  setProjectCcList,
  updateAdminProject,
} from "@pw-support/db";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ZodType, ZodTypeDef } from "zod";
import {
  toAdminProject,
  toIntegrationStatus,
  toIntegrationStatuses,
  toRequestDetail,
  toRequestItem,
} from "./admin-presenters";
import { parseBearer, type TokenValidator } from "./auth";
import type { ApiConfig } from "./config";
import type { ObjectStorage } from "./storage";

export interface AdminDeps {
  db: SupportDb;
  storage: ObjectStorage;
  config: ApiConfig;
  validator: TokenValidator;
  secretWriter: SecretWriter;
  secrets?: Pick<ManagedSecrets, "invalidate">;
}

export type AdminEnv = { Variables: { staff: StaffIdentity } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireStaff(
  validator: TokenValidator,
): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const token = parseBearer(c.req.header("Authorization"));
    const result = token ? await validator.verify(token) : null;
    if (result && !result.ok && result.kind === "forbidden") {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!result?.ok) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("staff", result.identity);
    return next();
  };
}

function limitMutations(
  db: SupportDb,
  config: ApiConfig,
): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const count = await hitRateLimit(db, {
      scope: "admin",
      subject: c.get("staff").sub,
      windowSeconds: config.rateLimit.windowSeconds,
    });
    if (count.hits > config.admin.mutationsPerWindow) {
      c.header("Retry-After", String(count.retryAfterSeconds));
      return c.json({ error: "rate_limited" }, 429);
    }
    return next();
  };
}

async function readBody<Output>(
  request: Request,
  schema: ZodType<Output, ZodTypeDef, unknown>,
): Promise<Output | null> {
  const raw: unknown = await request.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const BAD_REQUEST = { error: "invalid_request" } as const;
const NOT_FOUND = { error: "not_found" } as const;

export function adminRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const { db, config } = deps;
  const routes = new Hono<AdminEnv>();
  const allowed = new Set(config.adminOrigins);

  routes.onError((error, c) => {
    console.error("[admin] request failed", {
      method: c.req.method,
      path: c.req.path,
      error: error.name,
    });
    return c.json({ error: "internal_error" }, 500);
  });

  routes.use(
    "*",
    cors({
      origin: (origin) => (allowed.has(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      exposeHeaders: ["Retry-After", "Content-Disposition"],
      maxAge: 600,
    }),
    async (c, next) => {
      if (config.admin.disabled) {
        return c.json({ error: "admin_not_configured" }, 503);
      }
      return next();
    },
    requireStaff(deps.validator),
    bodyLimit({
      maxSize: config.admin.maxBodyBytes,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
    limitMutations(db, config),
  );

  routes.get("/me", (c) => c.json(c.get("staff")));

  routes.get("/requests", async (c) => {
    const filters = adminRequestFiltersSchema.safeParse(c.req.query());
    if (!filters.success) return c.json(BAD_REQUEST, 400);
    const { rows, nextCursor } = await listAdminRequests(db, filters.data);
    return c.json({ items: rows.map(toRequestItem), nextCursor });
  });

  routes.get("/requests/:id", async (c) => {
    const id = c.req.param("id");
    const detail = UUID.test(id) ? await getAdminRequestDetail(db, id) : null;
    return detail ? c.json(toRequestDetail(detail)) : c.json(NOT_FOUND, 404);
  });

  routes.get("/attachments/:id", async (c) => {
    const id = c.req.param("id");
    const row = UUID.test(id) ? await getAdminAttachment(db, id) : null;
    if (!row) return c.json(NOT_FOUND, 404);
    const object = await deps.storage.get(row.storageKey);
    return new Response(object.stream, {
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(row.sizeBytes),
        "Content-Disposition": contentDisposition(row.filename),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });

  routes.get("/projects", async (c) =>
    c.json((await listAdminProjects(db)).map(toAdminProject)),
  );

  routes.post("/projects", async (c) => {
    const input = await readBody(c.req.raw, createProjectInputSchema);
    if (!input) return c.json(BAD_REQUEST, 400);
    const project = await createAdminProject(db, input, c.get("staff"));
    if (!project) return c.json({ error: "project_exists" }, 409);
    const row = await getAdminProject(db, project.id);
    return c.json(row ? toAdminProject(row) : null, 201);
  });

  routes.patch("/projects/:id", async (c) => {
    const id = c.req.param("id");
    const input = await readBody(c.req.raw, updateProjectInputSchema);
    if (!input) return c.json(BAD_REQUEST, 400);
    const updated = UUID.test(id)
      ? await updateAdminProject(db, id, input, c.get("staff"))
      : null;
    const row = updated ? await getAdminProject(db, id) : null;
    return row ? c.json(toAdminProject(row)) : c.json(NOT_FOUND, 404);
  });

  routes.put("/projects/:id/cc-list", async (c) => {
    const id = c.req.param("id");
    const input = await readBody(c.req.raw, ccListInputSchema);
    if (!input) return c.json(BAD_REQUEST, 400);
    const updated = UUID.test(id)
      ? await setProjectCcList(db, id, input.emails, c.get("staff"))
      : null;
    const row = updated ? await getAdminProject(db, id) : null;
    return row ? c.json(toAdminProject(row)) : c.json(NOT_FOUND, 404);
  });

  routes.post("/projects/:id/keys", async (c) => {
    const id = c.req.param("id");
    const minted = UUID.test(id)
      ? await mintProjectKey(db, id, c.get("staff"))
      : null;
    if (!minted) return c.json(NOT_FOUND, 404);
    return c.json(
      {
        id: minted.id,
        key: minted.key,
        masked: maskProjectKey(minted.key),
        createdAt: minted.createdAt.toISOString(),
        revokedAt: null,
      },
      201,
    );
  });

  routes.post("/projects/:id/keys/:keyId/revoke", async (c) => {
    const id = c.req.param("id");
    const keyId = c.req.param("keyId");
    const revoked =
      UUID.test(id) && UUID.test(keyId)
        ? await revokeProjectKey(db, id, keyId, c.get("staff"))
        : false;
    const row = revoked ? await getAdminProject(db, id) : null;
    return row ? c.json(toAdminProject(row)) : c.json(NOT_FOUND, 404);
  });

  routes.get("/integrations", async (c) =>
    c.json(
      toIntegrationStatuses(await listIntegrations(db, config.secretsScope)),
    ),
  );

  routes.put("/integrations/:kind", async (c) => {
    const kind = integrationKindSchema.safeParse(c.req.param("kind"));
    if (!kind.success) return c.json(NOT_FOUND, 404);
    const input = await readBody(c.req.raw, saveIntegrationInputSchema);
    if (!input) return c.json(BAD_REQUEST, 400);
    const { secretName } = INTEGRATIONS[kind.data];
    let secretRef: string;
    try {
      secretRef = await deps.secretWriter.put(
        config.secretsScope,
        secretName,
        input.value,
      );
    } catch (error) {
      console.error("[admin] secret store write failed", {
        kind: kind.data,
        error: error instanceof Error ? error.name : "unknown",
      });
      return c.json({ error: "secret_store_unavailable" }, 502);
    }
    const row = await recordIntegration(
      db,
      { scope: config.secretsScope, kind: kind.data, secretRef },
      c.get("staff"),
    );
    deps.secrets?.invalidate(secretName);
    console.info("[admin] integration updated", { kind: kind.data });
    return c.json(toIntegrationStatus(kind.data, row));
  });

  return routes;
}
