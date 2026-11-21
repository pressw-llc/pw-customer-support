import { describe, expect, test } from "bun:test";
import {
  buildHoldWarning,
  classifyStaffComment,
  isConfirmComment,
  isSystemComment,
  plainReplyText,
} from "./reply/marker";
import { createJevWordingScorer, WORDING_QUESTION } from "./reply/wording";
import { wordingScorerFor } from "./runtime";

describe("marker rules", () => {
  test("the marker must open the body and end at whitespace", () => {
    expect(classifyStaffComment("@external Hello")).toEqual({
      kind: "external",
      text: "Hello",
    });
    expect(classifyStaffComment("  \n\t@external\nHello")).toEqual({
      kind: "external",
      text: "Hello",
    });
    expect(classifyStaffComment("@external").kind).toBe("internal");
    expect(classifyStaffComment("@external   \n").kind).toBe("internal");
    expect(classifyStaffComment("@externally Hello").kind).toBe("internal");
    expect(classifyStaffComment("@External Hello").kind).toBe("internal");
    expect(classifyStaffComment("​@external Hello").kind).toBe("internal");
    expect(classifyStaffComment("> @external Hello").kind).toBe("internal");
    expect(classifyStaffComment("a\n@external Hello").kind).toBe("internal");
  });

  test("the reply text drops control and bidi characters and normalizes newlines", () => {
    expect(plainReplyText("a\r\nb\u0000c‮d e\u007ff\u0085g")).toBe("a\nbcdefg");
    expect(plainReplyText("  keep\ttabs  ")).toBe("keep\ttabs");
  });

  test("the confirm command is the whole trimmed body", () => {
    expect(isConfirmComment("@confirm")).toBe(true);
    expect(isConfirmComment(" \n@confirm\t\n")).toBe(true);
    expect(isConfirmComment("@confirm please")).toBe(false);
    expect(isConfirmComment("@Confirm")).toBe(false);
    expect(isConfirmComment("​@confirm")).toBe(false);
    expect(isConfirmComment("")).toBe(false);
  });

  test("system comments are recognised by their fixed openings", () => {
    expect(isSystemComment("Customer follow-up via widget\n\n> hi")).toBe(true);
    expect(
      isSystemComment(
        buildHoldWarning({ reason: "too_long", score: 0, maxChars: 9 }),
      ),
    ).toBe(true);
    expect(isSystemComment("@external hi")).toBe(false);
  });

  test("the hold warning is a fixed template per reason", () => {
    expect(
      buildHoldWarning({ reason: "wording_low", score: 1.94, maxChars: 10 }),
    ).toBe(
      "Reply held, not sent to the customer. The wording check scored it 1.9 out of 5. A reply needs 2.0 or more to send. Reply `@confirm` in this thread to send it as written. The hold expires after 24 hours.",
    );
    expect(
      buildHoldWarning({
        reason: "wording_unavailable",
        score: 0,
        maxChars: 10,
      }),
    ).toContain("The wording check was unavailable.");
    expect(
      buildHoldWarning({ reason: "too_long", score: 0, maxChars: 10 }),
    ).toContain("longer than 10 characters");
  });
});

describe("Jev wording scorer", () => {
  function answer(noul: number, status = 200) {
    return async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.questions.wording).toEqual(WORDING_QUESTION);
      expect(sent.state.content).toBe("Hello customer");
      return new Response(
        JSON.stringify({
          model: "jev-test",
          answers: { wording: { noul } },
          usage: { input_tokens: 10 },
        }),
        { status },
      );
    };
  }

  test("scales the yes probability to a 0 to 5 score and keeps the raw judgment", async () => {
    const scorer = createJevWordingScorer({
      apiKey: "k",
      fetcher: answer(0.5) as unknown as typeof fetch,
    });
    const result = await scorer.score("Hello customer");
    expect(result.score).toBe(2.5);
    expect(result.raw).toMatchObject({
      question: "fit-to-send-v1",
      model: "jev-test",
      noul: 0.5,
      scale: 5,
    });
  });

  test("throws on a failed or malformed answer", async () => {
    const failing = createJevWordingScorer({
      apiKey: "k",
      fetcher: (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(failing.score("x")).rejects.toThrow(/Jev answered 500/);
    const malformed = createJevWordingScorer({
      apiKey: "k",
      fetcher: (async () =>
        new Response(
          JSON.stringify({ answers: {} }),
        )) as unknown as typeof fetch,
    });
    await expect(malformed.score("x")).rejects.toThrow();
  });

  test("the runtime builds a scorer only when the key is set", () => {
    expect(wordingScorerFor({})).toBeNull();
    expect(wordingScorerFor({ TYPESAFE_API_KEY: "" })).toBeNull();
    expect(wordingScorerFor({ TYPESAFE_API_KEY: "k" })).not.toBeNull();
    expect(
      wordingScorerFor({ TYPESAFE_API_KEY: "k", JEV_TIMEOUT_MS: "500" }),
    ).not.toBeNull();
  });
});
