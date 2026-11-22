import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTokenValidator } from "./auth";
import { safeIssueMessage } from "./mcp";
import { createHarness } from "./testing/harness";
import {
  connectMcp,
  postMcp,
  type ServedApp,
  serveApp,
} from "./testing/mcp-client";
import { startTestIssuer, type TestIssuer } from "./testing/oidc";

let idp: TestIssuer;
let harness: Awaited<ReturnType<typeof createHarness>>;
let served: ServedApp;
const sub = `rate-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  idp = await startTestIssuer();
  harness = await createHarness({
    config: {
      mcp: { audiences: [], perWindow: 6, maxBodyBytes: 2048 },
    },
    deps: { validator: createTokenValidator(idp.authConfig()) },
  });
  served = serveApp(harness.app);
});

afterAll(async () => {
  served.stop();
  idp.stop();
  await harness.close();
});

describe("safeIssueMessage", () => {
  test("drops the received value and unrecognized key names", () => {
    expect(
      safeIssueMessage(
        "Invalid enum value. Expected 'a' | 'b', received 'secret'",
      ),
    ).toBe("Invalid enum value. Expected 'a' | 'b'");
    expect(safeIssueMessage("Unrecognized key(s) in object: 'secret'")).toBe(
      "Unrecognized key in result",
    );
    expect(safeIssueMessage("x".repeat(500))).toHaveLength(120);
  });
});

describe("mcp route limits", () => {
  test("rejects an oversized body", async () => {
    const token = await idp.token({ claims: { sub: `big-${sub}` } });
    const response = await postMcp(
      served.url,
      { Authorization: `Bearer ${token}`, "Content-Length": "999999" },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: { pad: "x".repeat(4000) },
      },
    );
    expect(response.status).toBe(413);
  });

  test("claims and results fail closed when no laptop backend is configured", async () => {
    const client = await connectMcp(
      served.url,
      await idp.token({ claims: { sub: `nolaptop-${sub}` } }),
    );
    const id = crypto.randomUUID();
    const claim = await client.callRaw("job_claim", { jobId: id });
    expect(claim.isError).toBe(true);
    const submit = await client.callRaw("job_submit_result", {
      jobId: id,
      claimToken: id,
      result: {},
    });
    expect(submit.isError).toBe(true);
    await client.close();
  });

  test("rate limits one engineer without affecting another", async () => {
    const token = await idp.token({ claims: { sub } });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await postMcp(
        served.url,
        { Authorization: `Bearer ${token}` },
        { jsonrpc: "2.0", id: attempt, method: "ping" },
      );
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get("retry-after")).not.toBeNull();
      }
    }
    expect(statuses.slice(0, 6).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]);
    const other = await postMcp(
      served.url,
      {
        Authorization: `Bearer ${await idp.token({ claims: { sub: `o-${sub}` } })}`,
      },
      { jsonrpc: "2.0", id: 1, method: "ping" },
    );
    expect(other.status).toBe(200);
  });
});
