import {
  hashedIdSchema,
  SUPPORT_KEY_HEADER,
  SUPPORT_USER_HEADER,
} from "@pw-support/contracts";
import {
  type CustomerScope,
  findProjectByKey,
  hitRateLimit,
  type SupportDb,
  upsertCustomer,
} from "@pw-support/db";
import type { MiddlewareHandler } from "hono";
import type { ApiConfig } from "./config";

export interface IntakeVariables {
  scope: CustomerScope;
  keyId: string;
}

export type IntakeEnv = { Variables: IntakeVariables };

export function identify(db: SupportDb): MiddlewareHandler<IntakeEnv> {
  return async (c, next) => {
    const key = c.req.header(SUPPORT_KEY_HEADER);
    const resolved = key ? await findProjectByKey(db, key) : null;
    if (!resolved) return c.json({ error: "unauthorized" }, 401);
    const hashed = hashedIdSchema.safeParse(c.req.header(SUPPORT_USER_HEADER));
    if (!hashed.success) return c.json({ error: "invalid_user" }, 400);
    const customer = await upsertCustomer(db, resolved.project.id, hashed.data);
    c.set("scope", { project: resolved.project, customer });
    c.set("keyId", resolved.keyId);
    return next();
  };
}

export function rateLimit(
  db: SupportDb,
  config: ApiConfig["rateLimit"],
): MiddlewareHandler<IntakeEnv> {
  return async (c, next) => {
    const { project, customer } = c.get("scope");
    const checks = [
      { scope: "key", subject: c.get("keyId"), limit: config.perKey },
      {
        scope: "user",
        subject: `${project.id}:${customer.hashedId}`,
        limit: config.perUser,
      },
    ];
    for (const check of checks) {
      const count = await hitRateLimit(db, {
        scope: check.scope,
        subject: check.subject,
        windowSeconds: config.windowSeconds,
      });
      if (count.hits > check.limit) {
        c.header("Retry-After", String(count.retryAfterSeconds));
        return c.json({ error: "rate_limited" }, 429);
      }
    }
    return next();
  };
}
