import { describe, expect, test } from "bun:test";
import {
  messageAudiences,
  messageAuthors,
  messageSchema,
  originChannels,
} from "./message";

describe("message enums", () => {
  test("list the origin channels, authors, and audiences", () => {
    expect(originChannels).toEqual([
      "widget",
      "linear",
      "slack",
      "email",
      "claude_code",
    ]);
    expect(messageAuthors).toEqual(["customer", "staff", "system"]);
    expect(messageAudiences).toEqual(["external", "internal"]);
  });
});

describe("messageSchema", () => {
  const valid = {
    body: "The export button fails.",
    originChannel: "widget",
    author: "customer",
    audience: "external",
  };

  test("accepts a complete message", () => {
    expect(messageSchema.parse(valid)).toMatchObject(valid);
  });

  test("rejects an empty body", () => {
    expect(messageSchema.safeParse({ ...valid, body: "" }).success).toBe(false);
  });

  test.each(["originChannel", "author", "audience"])(
    "rejects an unknown %s",
    (field) => {
      expect(
        messageSchema.safeParse({ ...valid, [field]: "other" }).success,
      ).toBe(false);
    },
  );
});
