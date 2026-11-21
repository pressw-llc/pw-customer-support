import { describe, expect, test } from "bun:test";
import {
  type AttachmentInput,
  type ExtractLimits,
  extractAttachments,
  extractDocx,
  extractPdf,
  extractPptx,
  extractXlsx,
} from "./extract";
import {
  makeDocx,
  makePdf,
  makePng,
  makePptx,
  makeXlsx,
  makeZip,
} from "./testing/files";

const limits: ExtractLimits = {
  maxCharsPerFile: 100,
  maxCharsTotal: 150,
  maxImages: 1,
  maxImageBytes: 1024,
};

const enc = (text: string) => new TextEncoder().encode(text);

function input(
  filename: string,
  contentType: string,
  bytes: Uint8Array,
): AttachmentInput {
  return { id: filename, filename, contentType, bytes };
}

describe("document extractors", () => {
  test("docx paragraphs keep order and decode entities", () => {
    const text = extractDocx(makeDocx(["Error 500 & retry", "Second <line>"]));
    expect(text.trim()).toBe("Error 500 & retry\nSecond <line>");
  });

  test("pptx slides keep numeric order", () => {
    const slides = Array.from({ length: 11 }, (_, i) => [`slide ${i + 1}`]);
    const text = extractPptx(makePptx(slides));
    expect(text.indexOf("slide 2")).toBeLessThan(text.indexOf("slide 10"));
    expect(text).toContain("slide 11");
  });

  test("xlsx resolves shared strings and numbers", () => {
    const text = extractXlsx(
      makeXlsx([
        ["invoice", "total"],
        ["INV-1", 42],
      ]),
    );
    expect(text).toBe("invoice\ttotal\nINV-1\t42");
  });

  test("pdf text comes from the page content", async () => {
    const text = await extractPdf(
      makePdf(["Invoice INV-7 failed", "Code E-1234 (retry)"]),
    );
    expect(text).toContain("Invoice INV-7 failed");
    expect(text).toContain("E-1234");
  });
});

describe("extractAttachments", () => {
  const big = { ...limits, maxCharsPerFile: 10_000, maxCharsTotal: 10_000 };

  test("text, csv, json, and log files decode as text", async () => {
    const items = await extractAttachments(
      [
        input("a.txt", "text/plain", enc("plain\r\n\r\n\r\ntext\u0000")),
        input("b.csv", "text/csv", enc("a,b\n1,2")),
        input("c.json", "application/json", enc('{"k":1}')),
        input("d.log", "text/x-log", enc("ERROR boom")),
      ],
      big,
    );
    expect(items.map((item) => item.kind)).toEqual([
      "document",
      "document",
      "document",
      "document",
    ]);
    expect(items[0]).toMatchObject({ text: "plain\n\ntext" });
  });

  test("office documents and pdf extract through their content type", async () => {
    const items = await extractAttachments(
      [
        input(
          "a.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          makeDocx(["doc text"]),
        ),
        input(
          "b.xlsx",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          makeXlsx([["cell"]]),
        ),
        input(
          "c.pptx",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          makePptx([["slide text"]]),
        ),
        input("d.pdf", "application/pdf", makePdf(["pdf text"])),
      ],
      big,
    );
    expect(items.map((item) => item.kind === "document" && item.text)).toEqual([
      "doc text",
      "cell",
      "slide text",
      "pdf text",
    ]);
  });

  test("zip content is stored and never extracted", async () => {
    const [item] = await extractAttachments(
      [input("a.zip", "application/zip", makeZip())],
      big,
    );
    expect(item).toEqual({
      kind: "skipped",
      id: "a.zip",
      filename: "a.zip",
      reason: "archive_not_extracted",
    });
  });

  test("legacy office, empty text, and corrupt files are skipped with a reason", async () => {
    const items = await extractAttachments(
      [
        input("a.doc", "application/msword", enc("x")),
        input("b.txt", "text/plain", enc("   ")),
        input("c.pdf", "application/pdf", enc("not a pdf")),
        input("d.bin", "application/octet-stream", enc("x")),
        input(
          "e.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          enc("not a zip"),
        ),
      ],
      big,
    );
    expect(items.map((item) => item.kind === "skipped" && item.reason)).toEqual(
      [
        "legacy_office_not_supported",
        "no_text_found",
        "extraction_failed",
        "type_not_supported",
        "extraction_failed",
      ],
    );
  });

  test("images pass through with a cap on count, size, and format", async () => {
    const png = makePng();
    const items = await extractAttachments(
      [
        input("a.png", "image/png", png),
        input("b.png", "image/png", png),
        input("c.png", "image/png", new Uint8Array(2048)),
        input("d.tiff", "image/tiff", png),
      ],
      limits,
    );
    expect(items[0]).toMatchObject({ kind: "image", format: "png" });
    expect(items[1]).toMatchObject({ kind: "skipped", reason: "image_limit" });
    expect(items[2]).toMatchObject({
      kind: "skipped",
      reason: "image_too_large",
    });
    expect(items[3]).toMatchObject({
      kind: "skipped",
      reason: "type_not_supported",
    });
    const gif = await extractAttachments([input("e.gif", "image/gif", png)], {
      ...limits,
      maxImages: 3,
    });
    expect(gif[0]).toMatchObject({ kind: "image", format: "gif" });
  });

  test("text is capped per file and in total", async () => {
    const items = await extractAttachments(
      [
        input("a.txt", "text/plain", enc("a".repeat(500))),
        input("b.txt", "text/plain", enc("b".repeat(500))),
        input("c.txt", "text/plain", enc("c".repeat(500))),
      ],
      limits,
    );
    expect(items[0]).toMatchObject({ truncated: true });
    expect((items[0] as { text: string }).text).toHaveLength(100);
    expect((items[1] as { text: string }).text).toHaveLength(50);
    expect(items[2]).toMatchObject({
      kind: "skipped",
      reason: "text_budget_exhausted",
    });
  });
});
