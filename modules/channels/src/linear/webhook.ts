import { createHmac, timingSafeEqual } from "node:crypto";
import {
  LINEAR_WEBHOOK_MAX_AGE_SECONDS,
  LINEAR_WEBHOOK_MAX_BYTES,
} from "@pw-support/contracts";
import { persistInboundComment, type SupportDb } from "@pw-support/db";
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
    .object({ name: z.string().nullish() })
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
});

export function signLinearWebhook(
  secret: string,
  rawBody: Uint8Array | string,
): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function signatureMatches(
  secret: string,
  rawBody: Uint8Array,
  signature: string | null | undefined,
): boolean {
  if (!signature || !SIGNATURE_HEX.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

function authorNameOf(
  comment: z.infer<typeof commentSchema>,
  actor: z.infer<typeof payloadSchema>["actor"],
): string | null {
  const raw = comment.user?.name ?? actor?.name ?? "";
  const cleaned = plainReplyText(raw).slice(0, MAX_AUTHOR_NAME_CHARS).trim();
  return cleaned === "" ? null : cleaned;
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
      const ageMs = Math.abs(
        clock().getTime() - payload.data.webhookTimestamp,
      );
      if (ageMs > LINEAR_WEBHOOK_MAX_AGE_SECONDS * 1000) {
        return respond(401, { error: "stale_timestamp" });
      }
      const delivery = request.delivery?.trim();
      if (!delivery || delivery.length > 200) {
        return respond(400, { error: "delivery_required" });
      }
      if (payload.data.type !== "Comment" || payload.data.action !== "create") {
        return respond(200, { status: "ignored", reason: "event_not_handled" });
      }
      const comment = commentSchema.safeParse(payload.data.data);
      if (!comment.success) {
        return respond(200, { status: "ignored", reason: "not_an_issue_comment" });
      }
      const result = await persistInboundComment(deps.db, {
        deliveryId: delivery,
        commentId: comment.data.id,
        issueId: comment.data.issueId,
        parentCommentId: comment.data.parentId ?? null,
        authorId: comment.data.userId ?? null,
        authorName: authorNameOf(comment.data, payload.data.actor),
        body: comment.data.body,
      });
      if (result.status === "stored") {
        return respond(200, { status: "accepted" });
      }
      return respond(200, {
        status: "ignored",
        reason: result.status,
      });
    },
  };
}
