import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { hashCustomerId, hashedIdSchema } from "./identity";

describe("hashCustomerId", () => {
  test("returns SHA-256 of email followed by key as lowercase hex", async () => {
    const expected = createHash("sha256")
      .update("user@acme.test" + "pk_acme_portal")
      .digest("hex");
    expect(await hashCustomerId("user@acme.test", "pk_acme_portal")).toBe(
      expected,
    );
  });

  test("matches a fixed vector", async () => {
    expect(await hashCustomerId("", "abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("differs when the key differs", async () => {
    const a = await hashCustomerId("user@acme.test", "key-a");
    const b = await hashCustomerId("user@acme.test", "key-b");
    expect(a).not.toBe(b);
  });

  test("produces a value the hashed id schema accepts", async () => {
    const hash = await hashCustomerId("user@acme.test", "key");
    expect(hashedIdSchema.safeParse(hash).success).toBe(true);
  });
});

describe("hashedIdSchema", () => {
  test("rejects uppercase, short, and non-hex values", () => {
    expect(hashedIdSchema.safeParse("A".repeat(64)).success).toBe(false);
    expect(hashedIdSchema.safeParse("a".repeat(63)).success).toBe(false);
    expect(hashedIdSchema.safeParse("g".repeat(64)).success).toBe(false);
  });
});
