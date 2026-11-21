import { createHmac } from "node:crypto";

export function signLinearWebhook(
  secret: string,
  rawBody: Uint8Array | string,
): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
