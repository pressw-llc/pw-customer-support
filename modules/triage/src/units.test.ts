import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_MODEL, loadTriageConfig } from "./config";
import { chunkText, INJECTION_KIND, runInjectionFilter } from "./filter";
import { createJevClient, JEV_ENDPOINT } from "./jev";
import { parseAgentOutput } from "./parse";
import { jevFromEnv, resolveAgentId } from "./runtime";
import { fakeJev } from "./testing/harness";

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected an item");
  return item;
}

describe("loadTriageConfig", () => {
  test("uses the documented defaults", () => {
    const config = loadTriageConfig({});
    expect(config.timing).toEqual({
      initialDelaySeconds: 60,
      leaseSeconds: 120,
      maxAttempts: 3,
      intakeGraceSeconds: 300,
    });
    expect(config.jev.threshold).toBe(0.5);
    expect(config.agent.model).toBe(DEFAULT_AGENT_MODEL);
    expect(config.agent.id).toBeUndefined();
    expect(config.wakeQueue).toBe("pw-support-triage-wake");
  });

  test("reads overrides and ignores bad numbers", () => {
    const config = loadTriageConfig({
      TRIAGE_INITIAL_DELAY_SECONDS: "4",
      TRIAGE_LEASE_SECONDS: "0",
      TRIAGE_MAX_ATTEMPTS: "x",
      JEV_INJECTION_THRESHOLD: "0.8",
      JEV_JUDGE_IMAGES: "true",
      TRIAGE_AGENT_MODEL: "claude-test",
      TRIAGE_AGENT_ID: "agent_1",
      TRIAGE_AGENT_TIMEOUT_SECONDS: "5",
    });
    expect(config.timing.initialDelaySeconds).toBe(4);
    expect(config.timing.leaseSeconds).toBe(1);
    expect(config.timing.maxAttempts).toBe(3);
    expect(config.jev.threshold).toBe(0.8);
    expect(config.jev.judgeImages).toBe(true);
    expect(config.agent).toEqual({
      model: "claude-test",
      id: "agent_1",
      timeoutMs: 5000,
    });
  });
});

describe("parseAgentOutput", () => {
  test("parses bare JSON, a fenced block, and returns text for garbage", () => {
    expect(parseAgentOutput('{"a":1}')).toEqual({ a: 1 });
    expect(parseAgentOutput('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseAgentOutput('```\n{"a":3}\n```')).toEqual({ a: 3 });
    expect(parseAgentOutput("here you go")).toBe("here you go");
  });
});

describe("createJevClient", () => {
  function clientWith(response: () => Response) {
    const requests: { url: string; init: RequestInit }[] = [];
    const client = createJevClient({
      apiKey: "test-key",
      fetcher: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return response();
      }) as unknown as typeof fetch,
    });
    return { client, requests };
  }

  test("sends a text judgment and reads the noul score", async () => {
    const { client, requests } = clientWith(() =>
      Response.json({
        model: "jev-1",
        answers: { injection: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 1 },
      }),
    );
    const judgment = await client.judgeInjection({ text: "hello" });
    expect(judgment.score).toBe(0.9);
    expect(first(requests).url).toBe(JEV_ENDPOINT);
    const sent = JSON.parse(first(requests).init.body as string);
    expect(sent.state).toEqual({ content: "hello" });
    expect(sent.questions.injection.type).toBe("noul");
    expect(
      (first(requests).init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-key");
  });

  test("sends an image as an asset with the images header", async () => {
    const { client, requests } = clientWith(() =>
      Response.json({ answers: { injection: { noul: 0.1 } } }),
    );
    await client.judgeInjection({ image: { format: "png", base64: "AAAA" } });
    const sent = JSON.parse(first(requests).init.body as string);
    expect(sent.assets.image).toEqual({
      type: "image",
      format: "png",
      data_base64: "AAAA",
    });
    expect(
      (first(requests).init.headers as Record<string, string>)[
        "TypeSafe-Danger-Zone-Images"
      ],
    ).toBe("true");
  });

  test("throws on an error status and on a malformed body", async () => {
    const failing = clientWith(() => new Response("nope", { status: 503 }));
    await expect(failing.client.judgeInjection({ text: "x" })).rejects.toThrow(
      /503/,
    );
    const malformed = clientWith(() => Response.json({ answers: {} }));
    await expect(
      malformed.client.judgeInjection({ text: "x" }),
    ).rejects.toThrow();
  });
});

describe("runInjectionFilter", () => {
  const base = { threshold: 0.5, chunkChars: 500, requestId: "req" };

  test("chunkText splits long text", () => {
    expect(chunkText("abc", 10)).toEqual(["abc"]);
    expect(chunkText("abcdef", 4)).toEqual(["abcd", "ef"]);
  });

  test("judges the message and each chunk, and flags when any chunk crosses the threshold", async () => {
    const jev = fakeJev((subject) =>
      subject.text?.includes("EVIL") ? 0.9 : 0.1,
    );
    const verdict = await runInjectionFilter(
      [
        { subject: "message", text: "hello" },
        { subject: "attachment:1", text: `${"a".repeat(600)}EVIL` },
        { subject: "empty", text: "   " },
      ],
      { ...base, jev },
    );
    expect(verdict.flagged).toBe(true);
    expect(verdict.unavailable).toBe(false);
    expect(verdict.judgments).toHaveLength(3);
    expect(verdict.judgments.every((j) => j.kind === INJECTION_KIND)).toBe(
      true,
    );
    const flagged = verdict.judgments.filter((j) => j.flagged);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.subject).toBe("attachment:1");
    expect(flagged[0]?.raw).toMatchObject({ chunk: 1, of: 2 });
  });

  test("an image subject is judged as an image", async () => {
    const jev = fakeJev();
    await runInjectionFilter(
      [{ subject: "image:1", image: { format: "png", base64: "AAAA" } }],
      { ...base, jev },
    );
    expect(jev.calls[0]?.image?.format).toBe("png");
  });

  test("fails closed without a client and on a client error", async () => {
    const none = await runInjectionFilter([{ subject: "message", text: "x" }], {
      ...base,
      jev: null,
    });
    expect(none).toMatchObject({ flagged: false, unavailable: true });
    const broken = await runInjectionFilter(
      [{ subject: "message", text: "x" }],
      { ...base, jev: fakeJev(() => new Error("timeout")) },
    );
    expect(broken).toMatchObject({
      flagged: false,
      unavailable: true,
      error: "timeout",
    });
  });
});

describe("runtime helpers", () => {
  test("jevFromEnv returns null without a key", () => {
    const config = loadTriageConfig({});
    expect(jevFromEnv(config, {})).toBeNull();
    expect(jevFromEnv(config, { TYPESAFE_API_KEY: "k" })).not.toBeNull();
  });

  test("resolveAgentId prefers the env id over the lock file", () => {
    const withId = loadTriageConfig({ TRIAGE_AGENT_ID: "agent_env" });
    expect(resolveAgentId(withId, "/nonexistent/agent.lock.json")).toBe(
      "agent_env",
    );
    const without = loadTriageConfig({});
    expect(
      resolveAgentId(without, "/nonexistent/agent.lock.json"),
    ).toBeUndefined();
  });
});
