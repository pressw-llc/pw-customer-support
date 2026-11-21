import { describe, expect, test } from "bun:test";
import {
  channelKeyMatches,
  channelKeySchema,
  formatChannelKey,
  parseChannelKey,
} from "./channel-key";

describe("channelKeySchema", () => {
  test.each(["acme", "acme:portal", "acme:portal:user-1", "a_b.c:p1:u2"])(
    "accepts %s",
    (key) => {
      expect(channelKeySchema.safeParse(key).success).toBe(true);
    },
  );

  test.each([
    "",
    ":",
    "acme:",
    ":portal",
    "acme::user",
    "acme:portal:user:extra",
    "acme portal",
    "-acme",
    "acme:p/q",
  ])("rejects %p", (key) => {
    expect(channelKeySchema.safeParse(key).success).toBe(false);
  });
});

describe("parseChannelKey", () => {
  test("parses one, two, and three segments", () => {
    expect(parseChannelKey("acme")).toEqual({ client: "acme" });
    expect(parseChannelKey("acme:portal")).toEqual({
      client: "acme",
      project: "portal",
    });
    expect(parseChannelKey("acme:portal:u1")).toEqual({
      client: "acme",
      project: "portal",
      user: "u1",
    });
  });

  test("throws on an invalid key", () => {
    expect(() => parseChannelKey("acme::u1")).toThrow();
  });
});

describe("formatChannelKey", () => {
  test("round-trips with parse", () => {
    for (const key of ["acme", "acme:portal", "acme:portal:u1"]) {
      expect(formatChannelKey(parseChannelKey(key))).toBe(key);
    }
  });

  test("rejects a user without a project", () => {
    expect(() => formatChannelKey({ client: "acme", user: "u1" })).toThrow(
      "needs a project",
    );
  });

  test("rejects an invalid segment", () => {
    expect(() => formatChannelKey({ client: "ac me" })).toThrow();
  });
});

describe("channelKeyMatches", () => {
  test("a client subscription matches every key for that client", () => {
    expect(channelKeyMatches("acme", "acme")).toBe(true);
    expect(channelKeyMatches("acme", "acme:p")).toBe(true);
    expect(channelKeyMatches("acme", "acme:p:u")).toBe(true);
  });

  test("a project subscription matches that project only", () => {
    expect(channelKeyMatches("acme:p", "acme:p:u")).toBe(true);
    expect(channelKeyMatches("acme:other", "acme:p:u")).toBe(false);
  });

  test("a user subscription matches one user only", () => {
    expect(channelKeyMatches("acme:p:u", "acme:p:u")).toBe(true);
    expect(channelKeyMatches("acme:p:u", "acme:p:v")).toBe(false);
  });

  test("a longer subscription never matches a shorter key", () => {
    expect(channelKeyMatches("acme:p", "acme")).toBe(false);
  });

  test("matches whole segments, not string prefixes", () => {
    expect(channelKeyMatches("acme", "acmecorp:p")).toBe(false);
    expect(channelKeyMatches("acme:p", "acme:pp:u")).toBe(false);
  });

  test("a different client never matches", () => {
    expect(channelKeyMatches("acme", "globex:p:u")).toBe(false);
  });
});
