import { lt, sql } from "drizzle-orm";
import type { SupportExecutor } from "./client";
import { rateLimits } from "./schema";

const RETENTION_MS = 60 * 60 * 1000;

export interface RateLimitHit {
  scope: string;
  subject: string;
  windowSeconds: number;
  now?: number;
}

export interface RateLimitCount {
  hits: number;
  retryAfterSeconds: number;
}

export async function hitRateLimit(
  db: SupportExecutor,
  input: RateLimitHit,
): Promise<RateLimitCount> {
  const now = input.now ?? Date.now();
  const windowMs = input.windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const [row] = await db
    .insert(rateLimits)
    .values({
      scope: input.scope,
      subject: input.subject,
      windowStart: new Date(windowStart),
      hits: 1,
    })
    .onConflictDoUpdate({
      target: [rateLimits.scope, rateLimits.subject, rateLimits.windowStart],
      set: { hits: sql`${rateLimits.hits} + 1` },
    })
    .returning({ hits: rateLimits.hits });
  const hits = row?.hits ?? 1;
  if (hits === 1) {
    await db
      .delete(rateLimits)
      .where(lt(rateLimits.windowStart, new Date(now - RETENTION_MS)));
  }
  return {
    hits,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStart + windowMs - now) / 1000),
    ),
  };
}
