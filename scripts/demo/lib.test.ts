import { describe, expect, test } from "bun:test";
import {
  commentRequest,
  degradedNotes,
  demoUrls,
  isAlive,
  parseState,
  walkthrough,
} from "./lib";

const ports = { api: 1, stub: 2, viewer: 3, admin: 4, host: 5 };

describe("demo helpers", () => {
  test("builds the URLs from the ports", () => {
    const urls = demoUrls(ports, "4599");
    expect(urls.api).toBe("http://127.0.0.1:1");
    expect(urls.admin).toBe("http://127.0.0.1:4");
    expect(urls.host).toContain("127.0.0.1:5/?email=ada@acme.test");
    expect(urls.viewer).toBe("http://127.0.0.1:3");
    expect(urls.issuer).toBe("http://127.0.0.1:4599/support");
  });

  test("numbers a walkthrough that covers the widget, the stub, and the admin app", () => {
    const steps = walkthrough(demoUrls(ports, "4599"));
    const text = steps.join("\n");
    expect(steps.length).toBeGreaterThanOrEqual(10);
    expect(text).toContain("bun run demo comment ACME-1");
    expect(text).toContain("@external");
    expect(text).toContain("unread badge");
    expect(text).toContain("admin");
    expect(text).toContain("bun run demo stop");
  });

  test("says which steps degrade without the Jev and agent keys", () => {
    expect(degradedNotes({})).toHaveLength(2);
    expect(degradedNotes({})[0]).toContain("human triage");
    expect(degradedNotes({})[0]).toContain("held");
    expect(
      degradedNotes({
        TYPESAFE_API_KEY: "k",
        TRIAGE_AGENT_ID: "a",
        ANTHROPIC_API_KEY: "k",
      }),
    ).toEqual([]);
  });

  test("parses state and rejects garbage", () => {
    const raw = JSON.stringify({ ports, pids: { api: 9 }, startedStack: true });
    expect(parseState(raw)?.pids.api).toBe(9);
    expect(parseState("nope")).toBeUndefined();
    expect(parseState("{}")).toBeUndefined();
  });

  test("probes a pid", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(
      isAlive(1, () => {
        throw new Error("ESRCH");
      }),
    ).toBe(false);
  });

  test("builds a comment request", () => {
    expect(commentRequest(["ACME-1", "hello", "there"])).toEqual({
      identifier: "ACME-1",
      body: "hello there",
    });
    expect(() => commentRequest(["ACME-1"])).toThrow("usage");
    expect(() => commentRequest([])).toThrow("usage");
  });
});
