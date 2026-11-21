import { describe, expect, test } from "bun:test";
import type { AttachmentRejectionReason } from "@pw-support/contracts";
import { detectFile, preflightAttachment, zipEntryNames } from "./file-type";
import {
  capInboundText,
  checkMessage,
  MAX_STORED_MESSAGE_CHARS,
  stripMarkup,
} from "./message-checks";
import { fixtures } from "./testing/fixtures";

const docx = fixtures.zip(["[Content_Types].xml", "word/document.xml"]);
const xlsx = fixtures.zip(["[Content_Types].xml", "xl/workbook.xml"]);
const pptx = fixtures.zip(["[Content_Types].xml", "ppt/presentation.xml"]);

const accepted: [string, string, Uint8Array, string][] = [
  ["png", "shot.png", fixtures.png(), "image/png"],
  ["jpeg", "photo.jpg", fixtures.jpeg(), "image/jpeg"],
  ["gif", "anim.gif", fixtures.gif(), "image/gif"],
  ["webp", "pic.webp", fixtures.webp(), "image/webp"],
  ["pdf", "report.pdf", fixtures.pdf(), "application/pdf"],
  ["text", "notes.txt", fixtures.text(), "text/plain"],
  ["log", "app.log", fixtures.text(), "text/x-log"],
  ["csv", "rows.csv", fixtures.text("a,b\n1,2\n"), "text/csv"],
  ["json", "data.json", fixtures.text('{"a":1}'), "application/json"],
  ["markdown", "readme.md", fixtures.text("# hi"), "text/markdown"],
  ["extensionless text", "LICENSE", fixtures.text(), "text/plain"],
  ["unicode text", "t.txt", fixtures.text("héllo 世界"), "text/plain"],
  [
    "docx",
    "a.docx",
    docx,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    "xlsx",
    "a.xlsx",
    xlsx,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    "pptx",
    "a.pptx",
    pptx,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["legacy doc", "a.doc", fixtures.ole(), "application/msword"],
  ["legacy xls", "a.xls", fixtures.ole(), "application/vnd.ms-excel"],
  ["legacy ppt", "a.ppt", fixtures.ole(), "application/vnd.ms-powerpoint"],
  [
    "plain zip",
    "bundle.zip",
    fixtures.zip(["a.txt", "b/c.txt"]),
    "application/zip",
  ],
  [
    "docx renamed to .bin-free name",
    "mystery",
    docx,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
];

const rejected: [string, string, Uint8Array, AttachmentRejectionReason][] = [
  ["ELF renamed invoice.pdf", "invoice.pdf", fixtures.elf(), "executable"],
  ["PE renamed photo.png", "photo.png", fixtures.pe(), "executable"],
  ["Mach-O renamed notes.txt", "notes.txt", fixtures.macho(), "executable"],
  ["shebang script renamed log", "run.log", fixtures.shebang(), "executable"],
  ["text named setup.exe", "setup.exe", fixtures.text(), "executable"],
  ["text named run.sh", "run.sh", fixtures.text("echo hi"), "executable"],
  ["mp4 renamed pdf", "clip.pdf", fixtures.mp4(), "video"],
  ["mov", "clip.mov", fixtures.mov(), "video"],
  ["webm", "clip.webm", fixtures.webm(), "video"],
  ["avi", "clip.avi", fixtures.avi(), "video"],
  ["heic image", "photo.heic", fixtures.heic(), "type_not_allowed"],
  ["text with NUL bytes", "a.txt", fixtures.nulText(), "type_not_allowed"],
  ["invalid utf-8", "a.txt", fixtures.badUtf8(), "type_not_allowed"],
  [
    "OLE with unknown extension",
    "setup.msi",
    fixtures.ole(),
    "type_not_allowed",
  ],
  ["truncated zip", "a.zip", fixtures.truncatedZip(), "type_not_allowed"],
];

describe("detectFile accepts by magic bytes", () => {
  test.each(accepted)("%s", (_label, filename, bytes, contentType) => {
    expect(detectFile(filename, bytes)).toEqual({ ok: true, contentType });
  });
});

describe("detectFile rejects by magic bytes, not by name", () => {
  test.each(rejected)("%s", (_label, filename, bytes, reason) => {
    expect(detectFile(filename, bytes)).toEqual({ ok: false, reason });
  });
});

describe("zipEntryNames", () => {
  test("lists entry names", () => {
    expect(zipEntryNames(fixtures.zip(["a", "b"]))).toEqual(["a", "b"]);
  });

  test("returns null without an end record or with a corrupt directory", () => {
    expect(zipEntryNames(fixtures.text("no zip here"))).toBeNull();
    const corrupt = fixtures.zip(["a"]);
    corrupt[corrupt.length - 6] = 0xff;
    expect(zipEntryNames(corrupt)).toBeNull();
  });

  test("treats the zip64 marker as an opaque archive", () => {
    const zip64 = fixtures.zip(["a"]);
    zip64[zip64.length - 12] = 0xff;
    zip64[zip64.length - 11] = 0xff;
    expect(zipEntryNames(zip64)).toEqual([]);
  });

  test("accepts an empty archive", () => {
    const empty = fixtures.zip([]);
    expect(detectFile("e.zip", empty)).toEqual({
      ok: true,
      contentType: "application/zip",
    });
  });
});

describe("preflightAttachment", () => {
  const mb = 1024 * 1024;
  const cases: [number, number, AttachmentRejectionReason | null][] = [
    [0, 1, null],
    [9, 25 * mb, null],
    [10, 1, "too_many_files"],
    [11, 1, "too_many_files"],
    [0, 26 * mb, "too_large"],
    [0, 25 * mb + 1, "too_large"],
    [0, 0, "empty"],
  ];
  test.each(cases)("index %i size %i is %p", (index, size, expected) => {
    expect(preflightAttachment({ index, size })).toBe(expected);
  });
});

describe("checkMessage", () => {
  test("passes plain text untouched", () => {
    expect(checkMessage("My export fails with <3 and a < b")).toEqual({
      sanitized: "My export fails with <3 and a < b",
      flagged: false,
      reasons: [],
    });
  });

  test.each([
    ["script block", "hi<script>alert(1)</script>there", "hithere"],
    ["style block", "a<style>body{}</style>b", "ab"],
    ["html tags", "<b>bold</b> <a href='x'>link</a>", "bold link"],
    ["comment", "x<!-- hidden -->y", "xy"],
    [
      "nested evasion",
      "<scr<script>x</script>ipt>alert(1)</scr<script>x</script>ipt>",
      "alert(1)",
    ],
    ["void element", "<img src=x onerror=1>hi", "hi"],
  ])("flags and strips %s", (_label, raw, sanitized) => {
    const verdict = checkMessage(raw);
    expect(verdict.sanitized).toBe(sanitized);
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasons).toContain("markup");
  });

  test("control characters are removed and flagged apart from markup", () => {
    const verdict = checkMessage("a\u0000b\u0007c");
    expect(verdict.sanitized).toBe("abc");
    expect(verdict.reasons).toEqual(["control_chars"]);
  });

  test.each([
    ["a less-than before a letter", "a<b", "a<b"],
    ["spaced comparison", "x < y > z", "x < y > z"],
    ["a placeholder with a hyphen", "<your-token>", "<your-token>"],
    ["an unknown element", "Press <Ctrl>+<C>", "Press <Ctrl>+<C>"],
    [
      "an unterminated known tag",
      "hello <img src=x onerror=",
      "hello <img src=x onerror=",
    ],
    ["an unknown tag lookalike", "x<scripts>y", "x<scripts>y"],
    ["a bare opener", "x<a", "x<a"],
  ])("keeps %s verbatim and does not flag it", (_label, raw, expected) => {
    expect(checkMessage(raw)).toEqual({
      sanitized: expected,
      flagged: false,
      reasons: [],
    });
  });

  test("N2 real html is the only thing that flags markup", () => {
    expect(checkMessage("<b>bold</b>")).toMatchObject({
      sanitized: "bold",
      reasons: ["markup"],
    });
    expect(checkMessage("<script>alert(1)</script>")).toMatchObject({
      sanitized: "",
      reasons: ["markup"],
    });
    expect(checkMessage("<img src=x onerror=1>")).toMatchObject({
      sanitized: "",
      reasons: ["markup"],
    });
  });

  test("an unclosed script opener drops its line and keeps the next", () => {
    expect(stripMarkup("ok <script src=x\nnext line")).toBe("ok \nnext line");
    expect(stripMarkup("ok <style\nnext")).toBe("ok \nnext");
  });

  test("flags and truncates text over the length cap", () => {
    const verdict = checkMessage("a".repeat(10_001));
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasons).toEqual(["too_long"]);
    expect(verdict.sanitized).toHaveLength(10_000);
  });

  test("stripMarkup keeps newlines and tabs", () => {
    expect(stripMarkup("a\n\tb")).toBe("a\n\tb");
  });

  test.each([
    ["an opener with a stray greater-than", "x<a>y", "xy"],
    ["a closing tag", "x</b>y", "xy"],
    ["an upper-case script block", "x<SCRIPT>bad</ScRiPt >y", "xy"],
    [
      "a script opener without a closer drops the tag and keeps the text",
      "x<script>bad",
      "xbad",
    ],
  ])("stripMarkup handles %s", (_label, raw, expected) => {
    expect(stripMarkup(raw)).toBe(expected);
  });
});

describe("H4 a tag must be well formed before it is removed", () => {
  test.each([
    ["a comparison with a known name", "a<b and c>d"],
    ["a comparison with two spaced words", "if x<y then a>b"],
    ["prose after an element name", "x <i think so> y"],
    ["a numeric comparison", "1<2 and 3>2"],
    ["an unquoted opener inside the tag", "<b a=1 <c>"],
    ["an unterminated tag with a value", "<img src=x onerror=alert(1)//"],
    ["a custom placeholder with no attributes", "<your-token> and <api-key>"],
    ["an address in angle brackets", "mail <john-doe@acme.test> today"],
  ])("keeps %s verbatim and does not flag it", (_label, raw) => {
    expect(checkMessage(raw)).toEqual({
      sanitized: raw,
      flagged: false,
      reasons: [],
    });
  });

  test.each([
    ["a quoted greater-than inside an attribute", '<b class="a>b">x</b>', "x"],
    ["an unquoted event handler", "<b onclick=alert(1)>x", "x"],
    ["a boolean attribute", "<input disabled>y", "y"],
    ["a self closing element", "a<br/>b<br />c", "abc"],
    [
      "a custom element with an event handler",
      '<x-a onmouseover="alert(1)">hover</x-a>',
      "hover",
    ],
    ["a custom element with a value", "<my-card data-x=1>t</my-card>", "t"],
    ["a quoted angle bracket in a value", '<a title="<b>">k</a>', "k"],
    [
      "markup after an unclosed quote",
      '<b a="x <img src=x onerror=1>y',
      '<b a="x y',
    ],
  ])("removes and flags %s", (_label, raw, expected) => {
    const verdict = checkMessage(raw);
    expect(verdict.sanitized).toBe(expected);
    expect(verdict.reasons).toContain("markup");
  });
});

describe("markup stripping runs in linear time", () => {
  const inputs: [string, string][] = [
    ["unclosed anchors", "<a".repeat(500_000)],
    ["unclosed known openers with spaces", "<b ".repeat(166_000)],
    ["unclosed script openers across lines", "<script x\n".repeat(100_000)],
    ["known openers with one late closer", `${"<i ".repeat(160_000)}>`],
    ["placeholders and unknown elements", "<your-token><Ctrl>".repeat(50_000)],
    ["unclosed script openers", "<script ".repeat(200_000)],
    ["unclosed style openers", "<style ".repeat(200_000)],
    ["unclosed comments", "<!--".repeat(250_000)],
    [
      "script closers without a greater-than",
      "<script></script ".repeat(60_000),
    ],
    ["angle brackets only", "<".repeat(1_000_000)],
    ["unclosed single quotes", "<b a='".repeat(150_000)],
    ["alternating quote kinds", `<b a='x<b a="y`.repeat(70_000)],
    ["custom elements with open values", "<x-a b=".repeat(140_000)],
    ["open values and spaces", "<b a=1 ".repeat(140_000)],
    ["long quoted spans", `<b a="${"<i ".repeat(160_000)}`],
  ];

  test.each(inputs)("stripMarkup finishes quickly on %s", (_label, raw) => {
    const started = performance.now();
    stripMarkup(raw);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("capInboundText truncates before any stripping and keeps whole code points", () => {
    const raw = `${"a".repeat(MAX_STORED_MESSAGE_CHARS - 1)}\u{1F600}tail`;
    const capped = capInboundText(raw);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toHaveLength(MAX_STORED_MESSAGE_CHARS - 1);
    expect(capInboundText("short")).toEqual({
      text: "short",
      truncated: false,
    });
  });

  test("checkMessage bounds raw input and flags it as too_long", () => {
    const started = performance.now();
    const verdict = checkMessage("<a".repeat(500_000));
    expect(performance.now() - started).toBeLessThan(500);
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasons).toContain("too_long");
  });
});
