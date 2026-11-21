import { describe, expect, test } from "bun:test";
import { HUMAN_TRIAGE_LABEL, humanTriageResult } from "@pw-support/contracts";
import {
  buildTicket,
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
    customerText: "My export fails.",
    attachmentNames: [],
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
      customerText: hostile,
      attachmentNames: ["evil`name](x).png"],
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

  test("a title with markup or newlines becomes one clean line", () => {
    const draft = buildTicket({
      ...base,
      result: { ...VALID_RESULT, title: "<b>Bad</b>\n@all title" },
    });
    expect(draft.title).toBe("Bad @​all title");
  });
});
