import { createHmac, timingSafeEqual } from "node:crypto";
import {
  LINEAR_WEBHOOK_MAX_AGE_SECONDS,
  LINEAR_WEBHOOK_MAX_BYTES,
} from "@pw-support/contracts";
import {
  applyCommentChange,
  persistInboundComment,
  type SupportDb,
} from "@pw-support/db";
import { z } from "zod";
import { plainReplyText } from "../reply/marker";
import { LINEAR_WEBHOOK_SECRET, type SecretsProvider } from "./client";

export interface WebhookRequest {
  rawBody: Uint8Array;
  signature: string | null | undefined;
  delivery: string | null | undefined;
}

export interface WebhookResponse {
  status: 200 | 400 | 401 | 413 | 503;
  body: Record<string, unknown>;
}

export interface LinearWebhookIntake {
  handle(request: WebhookRequest): Promise<WebhookResponse>;
}

export interface LinearWebhookDeps {
  db: SupportDb;
  secrets: SecretsProvider;
  now?: () => Date;
}

const MAX_AUTHOR_NAME_CHARS = 80;
const SIGNATURE_HEX = /^[0-9a-f]{64}$/i;

const payloadSchema = z.object({
  action: z.string(),
  type: z.string(),
  webhookTimestamp: z.number(),
  data: z.record(z.unknown()).optional(),
  actor: z
    .object({ name: z.string().nullish(), type: z.string().nullish() })
    .partial()
    .nullish(),
});

const commentSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  issueId: z.string().min(1),
  parentId: z.string().min(1).nullish(),
  userId: z.string().min(1).nullish(),
  user: z.object({ name: z.string().nullish() }).partial().nullish(),
  createdAt: z.string().nullish(),
  botActor: z.unknown().nullish(),
  externalUserId: z.unknown().nullish(),
  externalUser: z.unknown().nullish(),
});

const changeSchema = z.object({
  id: z.string().min(1),
  body: z.string().optional(),
});

const present = (value: unknown): boolean =>
  value !== null && value !== undefined;

export function signatureMatches(
  secret: string,
  rawBody: Uint8Array,
  signature: string | null | undefined,
): boolean {
  if (!signature || !SIGNATURE_HEX.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

function authorNameOf(comment: z.infer<typeof commentSchema>): string | null {
  const cleaned = plainReplyText(comment.user?.name ?? "")
    .slice(0, MAX_AUTHOR_NAME_CHARS)
    .trim();
  return cleaned === "" ? null : cleaned;
}

function humanAuthorId(
  comment: z.infer<typeof commentSchema>,
  actor: z.infer<typeof payloadSchema>["actor"],
): string | null {
  const machine =
    present(comment.botActor) ||
    present(comment.externalUserId) ||
    present(comment.externalUser) ||
    (actor?.type != null && actor.type !== "user");
  return machine ? null : (comment.userId ?? null);
}

function sourceTime(raw: string | null | undefined, fallback: Date): Date {
  const parsed = raw ? new Date(raw) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
}

function cleanBody(body: string): string {
  return body.replaceAll("\u0000", "�");
}

function respond(
  status: WebhookResponse["status"],
  body: Record<string, unknown>,
): WebhookResponse {
  return { status, body };
}

export function createLinearWebhookIntake(
  deps: LinearWebhookDeps,
): LinearWebhookIntake {
  const clock = deps.now ?? (() => new Date());
  return {
    async handle(request) {
      if (request.rawBody.byteLength > LINEAR_WEBHOOK_MAX_BYTES) {
        return respond(413, { error: "payload_too_large" });
      }
      let secret: string;
      try {
        secret = await deps.secrets.get(LINEAR_WEBHOOK_SECRET);
      } catch {
        return respond(503, { error: "webhook_not_configured" });
      }
      if (!signatureMatches(secret, request.rawBody, request.signature)) {
        return respond(401, { error: "invalid_signature" });
      }
      let json: unknown;
      try {
        json = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(request.rawBody),
        );
      } catch {
        return respond(400, { error: "invalid_payload" });
      }
      const payload = payloadSchema.safeParse(json);
      if (!payload.success) return respond(400, { error: "invalid_payload" });
      const ageMs = Math.abs(clock().getTime() - payload.data.webhookTimestamp);
      if (ageMs > LINEAR_WEBHOOK_MAX_AGE_SECONDS * 1000) {
        return respond(401, { error: "stale_timestamp" });
      }
      const delivery = request.delivery?.trim();
      if (!delivery || delivery.length > 200) {
        return respond(400, { error: "delivery_required" });
      }
      if (payload.data.type !== "Comment") {
        return respond(200, { status: "ignored", reason: "event_not_handled" });
      }
      if (
        payload.data.action === "update" ||
        payload.data.action === "remove"
      ) {
        const change = changeSchema.safeParse(payload.data.data);
        if (!change.success) {
          return respond(200, {
            status: "ignored",
            reason: "not_an_issue_comment",
          });
        }
        const outcome = await applyCommentChange(deps.db, {
          deliveryId: delivery,
          commentId: change.data.id,
          action: payload.data.action,
          body:
            change.data.body === undefined
              ? undefined
              : cleanBody(change.data.body),
        });
        if (outcome.status === "cancelled") {
          return respond(200, { status: "accepted", change: "cancelled" });
        }
        if (outcome.status === "updated" || outcome.status === "removed") {
          return respond(200, { status: "accepted", change: outcome.status });
        }
        return respond(200, { status: "ignored", reason: outcome.status });
      }
      if (payload.data.action !== "create") {
        return respond(200, { status: "ignored", reason: "event_not_handled" });
      }
      const comment = commentSchema.safeParse(payload.data.data);
      if (!comment.success) {
        return respond(200, {
          status: "ignored",
          reason: "not_an_issue_comment",
        });
      }
      const result = await persistInboundComment(deps.db, {
        deliveryId: delivery,
        commentId: comment.data.id,
        issueId: comment.data.issueId,
        parentCommentId: comment.data.parentId ?? null,
        authorId: humanAuthorId(comment.data, payload.data.actor),
        authorName: authorNameOf(comment.data),
        body: cleanBody(comment.data.body),
        sourceCreatedAt: sourceTime(comment.data.createdAt, clock()),
      });
      if (result.status === "stored") {
        return respond(200, { status: "accepted" });
      }
      if (result.status === "awaiting_ticket") {
        return respond(200, { status: "accepted", pending: "awaiting_ticket" });
      }
      return respond(200, {
        status: "ignored",
        reason: result.status,
      });
    },
  };
}
