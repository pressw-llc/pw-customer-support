import { z } from "zod";

export const hashedIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

export async function hashCustomerId(
  email: string,
  projectKey: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(email + projectKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
