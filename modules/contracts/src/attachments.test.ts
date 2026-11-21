import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_LIMITS,
  attachmentBatchSchema,
  attachmentKindFor,
  attachmentKinds,
  attachmentMetaSchema,
  isVideoContentType,
} from "./attachments";

describe("ATTACHMENT_LIMITS", () => {
  test("allows 10 files of 25 MB", () => {
    expect(ATTACHMENT_LIMITS.maxFiles).toBe(10);
    expect(ATTACHMENT_LIMITS.maxBytes).toBe(26_214_400);
  });
});

describe("attachmentKindFor", () => {
  test("maps every listed content type to its kind", () => {
    for (const kind of attachmentKinds) {
      for (const type of ATTACHMENT_CONTENT_TYPES[kind]) {
        expect(attachmentKindFor(type)).toBe(kind);
      }
    }
  });

  test("ignores case, whitespace, and parameters", () => {
    expect(attachmentKindFor(" Image/PNG ")).toBe("image");
    expect(attachmentKindFor("text/plain; charset=utf-8")).toBe("text");
  });

  test.each([
    "video/mp4",
    "application/x-msdownload",
    "application/octet-stream",
    "",
  ])("returns null for %p", (type) => {
    expect(attachmentKindFor(type)).toBeNull();
  });
});

describe("isVideoContentType", () => {
  test("detects video types", () => {
    expect(isVideoContentType("video/mp4")).toBe(true);
    expect(isVideoContentType(" VIDEO/quicktime")).toBe(true);
    expect(isVideoContentType("image/png")).toBe(false);
  });
});

describe("attachmentMetaSchema", () => {
  const valid = {
    filename: "screenshot.png",
    contentType: "image/png",
    sizeBytes: 1024,
  };

  test("accepts a file at the size limit", () => {
    const meta = { ...valid, sizeBytes: ATTACHMENT_LIMITS.maxBytes };
    expect(attachmentMetaSchema.safeParse(meta).success).toBe(true);
  });

  test("rejects a file over the size limit", () => {
    const meta = { ...valid, sizeBytes: ATTACHMENT_LIMITS.maxBytes + 1 };
    expect(attachmentMetaSchema.safeParse(meta).success).toBe(false);
  });

  test("rejects video, empty, and unnamed files", () => {
    expect(
      attachmentMetaSchema.safeParse({ ...valid, contentType: "video/mp4" })
        .success,
    ).toBe(false);
    expect(
      attachmentMetaSchema.safeParse({ ...valid, sizeBytes: 0 }).success,
    ).toBe(false);
    expect(
      attachmentMetaSchema.safeParse({ ...valid, filename: "" }).success,
    ).toBe(false);
  });

  test("rejects a filename over 255 characters", () => {
    const filename = "a".repeat(256);
    expect(attachmentMetaSchema.safeParse({ ...valid, filename }).success).toBe(
      false,
    );
  });
});

describe("attachmentBatchSchema", () => {
  const file = {
    filename: "log.txt",
    contentType: "text/plain",
    sizeBytes: 10,
  };

  test("accepts 10 files and rejects 11", () => {
    expect(attachmentBatchSchema.safeParse(Array(10).fill(file)).success).toBe(
      true,
    );
    expect(attachmentBatchSchema.safeParse(Array(11).fill(file)).success).toBe(
      false,
    );
  });
});
