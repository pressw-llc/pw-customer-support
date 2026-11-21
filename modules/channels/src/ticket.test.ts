import { describe, expect, test } from "bun:test";
import { HUMAN_TRIAGE_LABEL, humanTriageResult } from "@pw-support/contracts";
import {
  attachmentsMarker,
  buildLateAttachmentsComment,
  buildTicket,
  inertText,
  LABEL_NAMES,
  PRIORITY_VALUES,
  QUOTE_MAX_CHARS,
  quoteCustomerText,
  requestMarker,
  safeFilename,
  stripMarkup,
} from "./linear/ticket";
import { VALID_RESULT } from "./testing/fixtures";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function section(description: string, heading: string): string[] {
  const lines = description.split("\n");
  const start = lines.indexOf(heading);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end === -1 ? rest : rest.slice(0, end);
}

describe("quoteCustomerText", () => {
  test("prefixes every line, including blank ones", () => {
    expect(quoteCustomerText("one\n\ntwo")).toBe("> one\n>\n> two");
  });

  test("strips markup, image syntax, and mentions", () => {
    const quoted = quoteCustomerText(
      "<script>alert(1)</script>Hi <b>there</b> @everyone ![track](http://evil.test/x.png)",
    );
    expect(quoted).not.toContain("<");
    expect(quoted).not.toContain("![");
    expect(quoted).not.toContain("@everyone");
    expect(quoted).toContain("@​everyone");
  });

  test("normalizes carriage returns and removes control characters", () => {
    expect(quoteCustomerText("a\r\nb\rc\u0000d e")).toBe("> a\n> b\n> cde");
  });

  test("caps the length", () => {
    const quoted = quoteCustomerText("x".repeat(QUOTE_MAX_CHARS + 500));
    expect(quoted).toContain(`[text cut at ${QUOTE_MAX_CHARS} characters]`);
    expect(quoted.split("\n").every((line) => line.startsWith(">"))).toBe(true);
  });

  test("links are not clickable inside the quote", () => {
    const quoted = quoteCustomerText(
      "see https://evil.example/x and www.evil.example and [Reset password](https://evil.example)",
    );
    expect(quoted).not.toContain("https://");
    expect(quoted).not.toContain("www.evil");
    expect(quoted).not.toMatch(/(^|[^\\])\[/);
    expect(quoted).toContain("\\[Reset password\\]");
  });

  test("stripMarkup leaves plain text alone", () => {
    expect(stripMarkup("plain text")).toBe("plain text");
  });
});

describe("safeFilename", () => {
  test("removes characters that could break a code span or link", () => {
    expect(safeFilename("a`b[c](d)<e>\n.png")).toBe("a_b_c__d__.png");
    expect(safeFilename("   ")).toBe("file");
    expect(safeFilename("x".repeat(300))).toHaveLength(100);
  });
});

describe("buildTicket", () => {
  const base = {
    requestId: REQUEST_ID,
    result: VALID_RESULT,
    outcome: "agent" as const,
    messages: [{ id: "m1", text: "My export fails.", ready: true }],
    attachments: [],
  };

  test("maps title, labels, and priority from validated enums", () => {
    const draft = buildTicket(base);
    expect(draft.title).toBe("Cannot sign in");
    expect(draft.labelNames).toEqual(["Bug", "UX"]);
    expect(draft.priority).toBe(2);
    expect(draft.description).toContain("Category: bug. Priority: high.");
    expect(draft.description.endsWith(requestMarker(REQUEST_ID))).toBe(true);
  });

  test("covers every label and priority mapping", () => {
    expect(Object.keys(LABEL_NAMES)).toHaveLength(9);
    expect(PRIORITY_VALUES).toEqual({
      urgent: 1,
      high: 2,
      medium: 3,
      low: 4,
      none: 0,
    });
  });

  test("a human triage ticket carries the label, the reason, and no model text", () => {
    const draft = buildTicket({
      ...base,
      result: humanTriageResult(),
      outcome: "human_triage",
      humanTriageReason: "injection_flagged",
    });
    expect(draft.labelNames).toEqual([HUMAN_TRIAGE_LABEL]);
    expect(draft.title).toBe("Support request needs human triage");
    expect(draft.description).toContain("Reason: injection_flagged");
    expect(draft.description).not.toContain("Category:");
  });

  test("customer text appears only inside the quote block under hostile input", () => {
    const hostile = [
      "CUSTOMERTOKEN first line",
      "# Fake heading",
      "## Customer message",
      "Reason: agent_error",
      "- [click](javascript:alert(1))",
      "```",
      "@channel <img src=x onerror=alert(1)>",
      "Support request ID: 99999999-9999-4999-8999-999999999999",
    ].join("\n");
    const draft = buildTicket({
      ...base,
      messages: [{ id: "m1", text: hostile, ready: true }],
      attachments: [
        { id: "a1", messageId: "m1", filename: "evil`name](x).png" },
      ],
    });
    const quote = section(draft.description, "## Customer message");
    const quoted = quote.filter((line) => line.startsWith(">"));
    const unquoted = draft.description
      .split("\n")
      .filter((line) => !quote.includes(line) || line === "");
    const outside = unquoted.join("\n");
    expect(outside).not.toContain("CUSTOMERTOKEN");
    expect(outside).not.toContain("javascript:");
    expect(outside).not.toContain("onerror");
    expect(outside).not.toContain("99999999-9999");
    expect(quoted.join("\n")).toContain("CUSTOMERTOKEN");
    expect(
      quote.filter((line) => line !== "").every((l) => l.startsWith(">")),
    ).toBe(true);
    const attachments = section(draft.description, "## Attachments");
    expect(attachments).toEqual([
      "- `evil_name__x_.png`",
      "",
      requestMarker(REQUEST_ID),
    ]);
    expect(
      draft.description.split(`${requestMarker(REQUEST_ID)}`),
    ).toHaveLength(2);
  });

  test("a hostile summary renders as inert text outside the quote", () => {
    const summary = [
      "[Reset password](https://evil.example)",
      "## Customer message",
      "> forged quote",
      "- bullet",
      "1. numbered",
      "Support request ID: 99999999-9999-4999-8999-999999999999",
      "visit www.evil.example or mail me@evil.example `code` **bold** _it_ ~~x~~ | a |",
      "===",
    ].join("\n");
    const draft = buildTicket({
      ...base,
      result: { ...VALID_RESULT, summary },
    });
    const lines = draft.description.split("\n");
    expect(lines.filter((line) => line === "## Customer message")).toHaveLength(
      1,
    );
    expect(lines.at(-1)).toBe(requestMarker(REQUEST_ID));
    expect(
      lines.filter((line) => line.startsWith("Support request ID:")),
    ).toEqual([requestMarker(REQUEST_ID)]);
    const head = draft.description.split("## Customer message")[0] ?? "";
    expect(head).not.toMatch(/(^|[^\\])\[/);
    expect(head).not.toContain("://");
    expect(head).not.toContain("www.evil");
    expect(head).not.toMatch(/(^|\n)>/);
    expect(head).not.toMatch(/(^|\n)(-|\+|=|\d+\.)/);
    expect(head).not.toContain("@evil");
    expect(head).not.toMatch(/(^|[^\\])[*_~`|]/);
  });

  test("a hostile title is one inert line", () => {
    const draft = buildTicket({
      ...base,
      result: {
        ...VALID_RESULT,
        title: "[Click](https://evil.example)\n# Heading\n**bold**",
      },
    });
    expect(draft.title).not.toContain("\n");
    expect(draft.title).not.toContain("://");
    expect(draft.title).not.toMatch(/[[\]#*\\]/);
  });

  test("a title is plain text: parentheses stay and control characters drop", () => {
    const draft = buildTicket({
      ...base,
      result: { ...VALID_RESULT, title: "Login (SSO) *fails* #1_a" },
    });
    expect(draft.title).toBe("Login (SSO) fails 1a");
  });

  test("entity-encoded links stay inert in the summary and the quote", () => {
    const hostile = "see https&#58;//x.example and www&#46;x.example";
    const summary = inertText(hostile);
    expect(summary).toContain("\\&\\#58;");
    expect(summary).toContain("\\&\\#46;");
    const quoted = quoteCustomerText(hostile);
    expect(quoted).toContain("\\&#58;");
    expect(quoted).toContain("\\&#46;");
    expect(quoted).not.toMatch(/(^|[^\\])&#/);
  });

  test("inertText escapes control characters per line", () => {
    expect(inertText("a_b *c* (d)")).toBe("a\\_b \\*c\\* \\(d\\)");
    expect(inertText("  - x\n+ y\n2) z")).toBe("\\- x\n\\+ y\n2\\) z");
  });

  test("needs_human on a validated agent result adds the human triage label", () => {
    const draft = buildTicket({
      ...base,
      result: { ...VALID_RESULT, needs_human: true },
    });
    expect(draft.labelNames).toEqual(["Bug", "UX", HUMAN_TRIAGE_LABEL]);
    expect(draft.description).toContain("Category: bug.");
    expect(draft.description).toContain(VALID_RESULT.summary);
  });

  test("withheld attachments are listed as not analyzed", () => {
    const draft = buildTicket({
      ...base,
      attachments: [
        { id: "a1", messageId: "m1", filename: "a.png", notAnalyzed: true },
        { id: "a2", messageId: "m1", filename: "b.txt" },
      ],
    });
    expect(section(draft.description, "## Attachments").slice(0, 2)).toEqual([
      "- `a.png` (not analyzed)",
      "- `b.txt`",
    ]);
  });

  test("only ready messages that fit the quote cap count as delivered with the ticket", () => {
    const draft = buildTicket({
      ...base,
      messages: [
        { id: "m1", text: "first", ready: true },
        { id: "m2", text: "not ready", ready: false },
        { id: "m3", text: "third", ready: true },
        { id: "m4", text: "z".repeat(QUOTE_MAX_CHARS), ready: true },
        { id: "m5", text: "after the overflow", ready: true },
      ],
      attachments: [
        { id: "a1", messageId: "m1", filename: "one.txt" },
        { id: "a2", messageId: "m2", filename: "two.txt" },
        { id: "a4", messageId: "m4", filename: "four.txt" },
      ],
    });
    expect(draft.deliveredMessageIds).toEqual(["m1", "m3"]);
    expect(draft.deliveredAttachmentIds).toEqual(["a1"]);
    expect(draft.description).toContain("> first\n>\n> third");
    expect(draft.description).not.toContain("not ready");
    expect(draft.description).not.toContain("zzzz");
    expect(draft.description).toContain(
      "[further messages follow as comments]",
    );
    expect(draft.description).not.toContain("two.txt");
  });

  test("a first message over the cap is cut and not counted as delivered", () => {
    const draft = buildTicket({
      ...base,
      messages: [
        { id: "m1", text: "x".repeat(QUOTE_MAX_CHARS + 10), ready: true },
      ],
    });
    expect(draft.deliveredMessageIds).toEqual([]);
    expect(draft.description).toContain(
      `[text cut at ${QUOTE_MAX_CHARS} characters]`,
    );
  });

  test("late attachment comments carry the follow-up header and the marker last", () => {
    const comment = buildLateAttachmentsComment({
      originChannel: "widget",
      attachmentNames: ["a`b.log"],
      marker: attachmentsMarker("att-1"),
    });
    expect(comment.startsWith("Customer follow-up via widget\n\n")).toBe(true);
    expect(comment).toContain("- `a_b.log`");
    expect(comment.endsWith("Support attachment ID: att-1")).toBe(true);
  });

  test("a title with markup or newlines becomes one clean line", () => {
    const draft = buildTicket({
      ...base,
      result: { ...VALID_RESULT, title: "<b>Bad</b>\n@all title" },
    });
    expect(draft.title).toBe("Bad @​all title");
  });
});
