import { z } from "zod";

export const WORDING_HOLD_BELOW = 2;
export const WORDING_FLAG_BELOW = 3;
export const WORDING_MAX_SCORE = 5;
export const REPLY_HOLD_TTL_SECONDS = 24 * 60 * 60;

export const LINEAR_WEBHOOK_MAX_BYTES = 256 * 1024;
export const LINEAR_WEBHOOK_MAX_AGE_SECONDS = 60;
export const LINEAR_SIGNATURE_HEADER = "Linear-Signature";
export const LINEAR_DELIVERY_HEADER = "Linear-Delivery";

export const replyHoldReasons = [
  "wording_low",
  "wording_unavailable",
  "too_long",
] as const;
export const replyHoldReasonSchema = z.enum(replyHoldReasons);
export type ReplyHoldReason = z.infer<typeof replyHoldReasonSchema>;

export const replyBands = ["hold", "send_flag", "send"] as const;
export type ReplyBand = (typeof replyBands)[number];

export function bandForScore(score: number): ReplyBand {
  if (!Number.isFinite(score) || score < WORDING_HOLD_BELOW) return "hold";
  return score < WORDING_FLAG_BELOW ? "send_flag" : "send";
}
