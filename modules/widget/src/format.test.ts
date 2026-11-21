import { describe, expect, test } from "bun:test";
import { SupportApiError } from "./client";
import {
  authorLabel,
  channelLabel,
  describeError,
  formatBytes,
  formatTime,
  rejectionMessage,
} from "./format";

describe("format helpers", () => {
  test("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  test("formats same-day and older times and tolerates bad input", () => {
    const now = new Date("2026-01-01T18:00:00.000Z");
    expect(formatTime("2026-01-01T12:00:00.000Z", now)).toMatch(/\d/);
    expect(formatTime("2025-06-01T12:00:00.000Z", now)).toMatch(/Jun/);
    expect(formatTime("not a date", now)).toBe("");
  });

  test("labels authors, channels, and rejection reasons", () => {
    expect(authorLabel("customer")).toBe("You");
    expect(authorLabel("staff")).toBe("Support");
    expect(channelLabel("claude_code")).toBe("Claude Code");
    expect(rejectionMessage("executable")).toContain("programs");
    expect(rejectionMessage(undefined)).toContain("not accepted");
  });

  test("describes api errors for the customer", () => {
    expect(describeError(new SupportApiError(429, "rate_limited"))).toContain(
      "Too many",
    );
    expect(describeError(new SupportApiError(401, "unauthorized"))).toContain(
      "not available",
    );
    expect(
      describeError(new SupportApiError(413, "payload_too_large")),
    ).toContain("too large");
    expect(describeError(new SupportApiError(500, "x"))).toContain("wrong");
    expect(describeError(new Error("boom"))).toContain("wrong");
  });
});
