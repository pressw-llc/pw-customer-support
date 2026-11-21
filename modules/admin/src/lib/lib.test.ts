import { describe, expect, test } from "bun:test";
import { configProblems, loadRuntimeConfig, resolveConfig } from "./config";
import { eventLabel, formatBytes, formatElapsed, relativeTime } from "./format";

describe("config", () => {
  test("runtime values win over build values and the scope has a default", () => {
    const config = resolveConfig(
      {
        VITE_API_URL: "http://build/",
        VITE_OIDC_AUTHORITY: "http://idp",
        VITE_OIDC_CLIENT_ID: "client",
      },
      { VITE_API_URL: "http://runtime///" },
      "http://admin",
    );
    expect(config).toEqual({
      apiUrl: "http://runtime",
      authority: "http://idp",
      clientId: "client",
      scope: "openid profile email",
      origin: "http://admin",
    });
    expect(configProblems(config)).toEqual([]);
  });

  test("lists the missing settings", () => {
    expect(configProblems(resolveConfig({}, {}, "x"))).toEqual([
      "VITE_API_URL",
      "VITE_OIDC_AUTHORITY",
      "VITE_OIDC_CLIENT_ID",
    ]);
  });

  test("loads the runtime file and ignores failures", async () => {
    const ok = async () => Response.json({ VITE_API_URL: "http://x" });
    expect(await loadRuntimeConfig(ok as unknown as typeof fetch)).toEqual({
      VITE_API_URL: "http://x",
    });
    const missing = async () => new Response("no", { status: 404 });
    expect(await loadRuntimeConfig(missing as unknown as typeof fetch)).toEqual(
      {},
    );
    const html = async () => Response.json("text");
    expect(await loadRuntimeConfig(html as unknown as typeof fetch)).toEqual(
      {},
    );
    const broken = async () => {
      throw new Error("offline");
    };
    expect(await loadRuntimeConfig(broken as unknown as typeof fetch)).toEqual(
      {},
    );
  });
});

describe("format", () => {
  test("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(3725)).toBe("1:02:05");
    expect(formatElapsed(-4)).toBe("0:00");
  });

  test("formats relative time", () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const ago = (seconds: number) =>
      new Date(now.getTime() - seconds * 1000).toISOString();
    expect(relativeTime(ago(10), now)).toBe("just now");
    expect(relativeTime(ago(50), now)).toBe("1m ago");
    expect(relativeTime(ago(600), now)).toBe("10m ago");
    expect(relativeTime(ago(7200), now)).toBe("2h ago");
    expect(relativeTime(ago(172800), now)).toBe("2d ago");
    expect(relativeTime("nope", now)).toBe("");
  });

  test("formats sizes and event names", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(eventLabel("triage.job.lease_expired")).toBe(
      "triage job lease expired",
    );
  });
});
