import { describe, expect, test } from "bun:test";
import type { AttachmentRejectionReason } from "@pw-support/contracts";
import { detectFile, preflightAttachment, zipEntryNames } from "./file-type";
import { checkMessage, stripMarkup } from "./message-checks";
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
    ["unterminated tag", "hello <img src=x onerror=", "hello "],
    ["control chars", "a\u0000b\u0007c", "abc"],
  ])("flags and strips %s", (_label, raw, sanitized) => {
    const verdict = checkMessage(raw);
    expect(verdict.sanitized).toBe(sanitized);
    expect(verdict.flagged).toBe(true);
    expect(verdict.reasons).toContain("markup");
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
});
