import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
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
  makePdfPages,
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

const ATTACK_OPENERS = 200_000;
const ATTACK_BOUND_MS = 1500;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

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

  test("numeric and unknown entities decode safely", () => {
    const bytes = zipSync({
      "word/document.xml": strToU8(
        "<w:p><w:t>&#65;&#x42;&#0;&amp;&bogus;</w:t></w:p>",
      ),
    });
    expect(extractDocx(bytes).trim()).toBe("AB&#0;&&bogus;");
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

describe("hostile office XML", () => {
  test("docx with 200k unclosed w:t openers finishes fast", () => {
    const bytes = zipSync({
      "word/document.xml": strToU8("<w:t>".repeat(ATTACK_OPENERS)),
    });
    const { value, ms } = timed(() => extractDocx(bytes));
    expect(value).toBe("");
    expect(ms).toBeLessThan(ATTACK_BOUND_MS);
  });

  test("docx that inflates to 40 MB of unclosed openers is cut at the entry cap", () => {
    const bytes = zipSync({
      "word/document.xml": strToU8("<w:t>".repeat(8_000_000)),
    });
    expect(bytes.byteLength).toBeLessThan(200_000);
    const { value, ms } = timed(() => extractDocx(bytes));
    expect(value).toBe("");
    expect(ms).toBeLessThan(ATTACK_BOUND_MS);
  });

  test("pptx with 200k unclosed a:t openers finishes fast", () => {
    const bytes = zipSync({
      "ppt/slides/slide1.xml": strToU8("<a:t>".repeat(ATTACK_OPENERS)),
    });
    const { value, ms } = timed(() => extractPptx(bytes));
    expect(value).toBe("");
    expect(ms).toBeLessThan(ATTACK_BOUND_MS);
  });

  test("xlsx with 200k unclosed cells and 200k unclosed shared strings finishes fast", () => {
    const bytes = zipSync({
      "xl/sharedStrings.xml": strToU8("<si><t>".repeat(ATTACK_OPENERS)),
      "xl/worksheets/sheet1.xml": strToU8(
        `<row>${"<c><v>".repeat(ATTACK_OPENERS)}</row>`,
      ),
    });
    const { value, ms } = timed(() => extractXlsx(bytes));
    expect(value).toBe("");
    expect(ms).toBeLessThan(ATTACK_BOUND_MS);
  });

  test("extraction stops once the character cap is reached", () => {
    const bytes = zipSync({
      "word/document.xml": strToU8(
        "<w:p><w:t>abcdefghij</w:t></w:p>".repeat(100_000),
      ),
    });
    const { value, ms } = timed(() => extractDocx(bytes, 50));
    expect(value.length).toBe(51);
    expect(ms).toBeLessThan(ATTACK_BOUND_MS);
  });

  test("self-closing and look-alike tags are not text runs", () => {
    const bytes = zipSync({
      "word/document.xml": strToU8(
        '<w:p><w:t/><w:tab/><w:tbl></w:tbl><w:t xml:space="preserve">kept</w:t></w:p>',
      ),
    });
    expect(extractDocx(bytes).trim()).toBe("kept");
    const sheet = zipSync({
      "xl/worksheets/sheet1.xml": strToU8(
        '<row><col min="1"/><c r="A1"/><c r="B1"><v>7</v></c><c r="C1"><is><t>in</t></is></c></row>',
      ),
    });
    expect(extractXlsx(sheet)).toBe("\t7\tin");
  });

  test("stored entries and truncated archives extract without throwing", () => {
    const stored = zipSync(
      { "word/document.xml": strToU8("<w:p><w:t>stored</w:t></w:p>") },
      { level: 0 },
    );
    expect(extractDocx(stored).trim()).toBe("stored");
    expect(() => extractDocx(stored.subarray(0, 20))).toThrow(/not a zip/);
  });

  test("a hostile docx through extractAttachments stays inside the worker budget", async () => {
    const bytes = zipSync({
      "word/document.xml": strToU8("<w:t>".repeat(ATTACK_OPENERS)),
    });
    const start = performance.now();
    const [item] = await extractAttachments(
      [
        input(
          "a.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes,
        ),
      ],
      { ...limits, maxCharsPerFile: 1000 },
    );
    expect(item).toMatchObject({ kind: "skipped", reason: "no_text_found" });
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe("isolated extraction", () => {
  const hangUrl = new URL("./testing/hang-worker.ts", import.meta.url);
  const docx =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  test("a worker that never answers is terminated and the file is not extracted", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    const start = performance.now();
    const [item] = await extractAttachments(
      [input("a.docx", docx, makeDocx(["x"]))],
      { ...limits, timeoutMs: 300 },
      { workerUrl: hangUrl },
    );
    clearInterval(timer);
    expect(item).toMatchObject({
      kind: "skipped",
      reason: "extraction_timeout",
    });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(ticks).toBeGreaterThan(10);
  });

  test("a worker that fails to load reports extraction_failed", async () => {
    const [item] = await extractAttachments(
      [input("a.docx", docx, makeDocx(["x"]))],
      limits,
      { workerUrl: new URL("./testing/missing-worker.ts", import.meta.url) },
    );
    expect(item).toMatchObject({
      kind: "skipped",
      reason: "extraction_failed",
    });
  });

  test("pdf extraction stops at the page cap", async () => {
    const pdf = makePdfPages([["page one"], ["page two"], ["page three"]]);
    expect(await extractPdf(pdf)).toContain("page three");
    const text = await extractPdf(pdf, { maxPages: 2 });
    expect(text).toContain("page two");
    expect(text).not.toContain("page three");
    expect(await extractPdf(pdf, { maxPages: 0 })).toBe("");
  });

  test("pdf character cap stops extraction early", async () => {
    const pdf = makePdfPages([["a".repeat(80)], ["b".repeat(80)]]);
    const text = await extractPdf(pdf, { maxChars: 20 });
    expect(text).not.toContain("b");
  });
});

describe("extractAttachments", () => {
  test("loaders run only for attachments that will be extracted", async () => {
    const loaded: string[] = [];
    const load = (name: string, bytes: Uint8Array) => async () => {
      loaded.push(name);
      return bytes;
    };
    const items = await extractAttachments(
      [
        {
          id: "z",
          filename: "a.zip",
          contentType: "application/zip",
          sizeBytes: 5,
          load: load("a.zip", makeZip()),
        },
        {
          id: "i",
          filename: "big.png",
          contentType: "image/png",
          sizeBytes: 999_999,
          load: load("big.png", makePng()),
        },
        {
          id: "t",
          filename: "a.txt",
          contentType: "text/plain",
          sizeBytes: 4,
          load: load("a.txt", enc("text")),
        },
        {
          id: "n",
          filename: "none.txt",
          contentType: "text/plain",
        },
      ],
      limits,
    );
    expect(loaded).toEqual(["a.txt"]);
    expect(items.map((item) => item.kind)).toEqual([
      "skipped",
      "skipped",
      "document",
      "skipped",
    ]);
    expect(items[3]).toMatchObject({ reason: "extraction_failed" });
  });

  test("raw text is sliced to the cap before cleaning", async () => {
    const [item] = await extractAttachments(
      [input("a.txt", "text/plain", enc("x".repeat(5_000_000)))],
      { ...limits, maxCharsPerFile: 100, maxCharsTotal: 1000 },
    );
    expect(item).toMatchObject({ kind: "document", truncated: true });
  });

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
