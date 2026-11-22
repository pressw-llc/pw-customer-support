import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  interactiveToolNames,
  SUBMIT_HEADER,
  WATCHER_HEADER,
  WATCHER_PATH,
} from "@pw-support/contracts";
import { createTokenValidator } from "./auth";
import { loadConfig } from "./config";
import { safeIssueMessage } from "./mcp";
import { createHarness } from "./testing/harness";
import {
  connectLaptop,
  connectMcp,
  LAPTOP_PATH,
  postMcp,
  registerWatcher,
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
      mcp: {
        audiences: [],
        requiredGroup: undefined,
        perWindow: 6,
        maxBodyBytes: 2048,
      },
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
    const token = await idp.token({ claims: { sub: `nolaptop-${sub}` } });
    const watcher = await registerWatcher(served.url, token);
    const client = await connectLaptop(served.url, token, watcher);
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

  const toolCall = (id: number, name: string, args: object = {}) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  test("rate limits only tool calls and keeps engineers apart", async () => {
    const token = await idp.token({ claims: { sub } });
    const headers = { Authorization: `Bearer ${token}` };
    for (let attempt = 0; attempt < 12; attempt++) {
      const free = await postMcp(served.url, headers, {
        jsonrpc: "2.0",
        id: attempt,
        method: attempt % 2 ? "ping" : "tools/list",
      });
      expect(free.status).toBe(200);
    }
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await postMcp(
        served.url,
        headers,
        toolCall(attempt, "subscriptions_list"),
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
      toolCall(1, "subscriptions_list"),
    );
    expect(other.status).toBe(200);
  });

  test("renew and submit stay available after the general limit is spent", async () => {
    const lease = `lease-${sub}`;
    const token = await idp.token({ claims: { sub: lease } });
    const watcher = await registerWatcher(served.url, token);
    const headers = {
      Authorization: `Bearer ${token}`,
      [WATCHER_HEADER]: watcher.header,
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      await postMcp(
        served.url,
        { Authorization: `Bearer ${token}` },
        toolCall(attempt, "subscriptions_list"),
      );
    }
    const spent = await postMcp(
      served.url,
      { Authorization: `Bearer ${token}` },
      toolCall(99, "subscriptions_list"),
    );
    expect(spent.status).toBe(429);
    const id = crypto.randomUUID();
    for (let attempt = 0; attempt < 10; attempt++) {
      const renew = await postMcp(
        served.url,
        headers,
        toolCall(attempt, "job_renew", { jobId: id, claimToken: id }),
        LAPTOP_PATH,
      );
      expect(renew.status).toBe(200);
    }
  });
});

describe("mcp surface split", () => {
  test("the interactive endpoint lists exactly the six state tools", async () => {
    const client = await connectMcp(
      served.url,
      await idp.token({ claims: { sub: `six-${sub}` } }),
    );
    expect((await client.tools()).sort()).toEqual(
      [...interactiveToolNames].sort(),
    );
    await client.close();
  });

  test("a job tool called on the interactive endpoint fails", async () => {
    const token = await idp.token({ claims: { sub: `jt-${sub}` } });
    const client = await connectMcp(served.url, token);
    const id = crypto.randomUUID();
    for (const [name, args] of [
      ["job_claim", { jobId: id }],
      ["job_renew", { jobId: id, claimToken: id }],
      ["job_submit_result", { jobId: id, claimToken: id, result: {} }],
    ] as const) {
      const raw = await client
        .callRaw(name, args)
        .catch(() => ({ isError: true, text: "" }));
      expect(raw.isError, name).toBe(true);
    }
    await client.close();
  });

  test("the laptop endpoint needs the watcher credential of the same engineer", async () => {
    const adaToken = await idp.token({ claims: { sub: `a-${sub}` } });
    const bobToken = await idp.token({ claims: { sub: `b-${sub}` } });
    const adaWatcher = await registerWatcher(served.url, adaToken);
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const call = (headers: Record<string, string>) =>
      postMcp(served.url, headers, rpc, LAPTOP_PATH);
    expect((await call({})).status).toBe(401);
    expect((await call({ Authorization: `Bearer ${adaToken}` })).status).toBe(
      401,
    );
    const asBob = await call({
      Authorization: `Bearer ${bobToken}`,
      [WATCHER_HEADER]: adaWatcher.header,
    });
    expect(asBob.status).toBe(403);
    const forged = await call({
      Authorization: `Bearer ${adaToken}`,
      [WATCHER_HEADER]: `${adaWatcher.machineId}.${"x".repeat(43)}`,
    });
    expect(forged.status).toBe(403);
    const malformed = await call({
      Authorization: `Bearer ${adaToken}`,
      [WATCHER_HEADER]: "nonsense",
    });
    expect(malformed.status).toBe(401);
    const ok = await call({
      Authorization: `Bearer ${adaToken}`,
      [WATCHER_HEADER]: adaWatcher.header,
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "job_claim",
      "job_renew",
      "job_status",
      "job_submit_result",
    ]);
  });

  test("a credential header that is not exactly 43 base64url characters is rejected with 401 before any database query", async () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("the database was queried");
        },
      },
    ) as never;
    const guarded = await createHarness({
      config: {
        mcp: {
          audiences: ["pw-support-test-client"],
          requiredGroup: undefined,
          perWindow: 50,
          maxBodyBytes: 2048,
        },
        auth: idp.authConfig(),
      },
      deps: { db: throwing },
    });
    const url = serveApp(guarded.app);
    try {
      const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
      const machine = crypto.randomUUID();
      const token = await idp.token({ claims: { sub: "shape-" + sub } });
      const bearer = { Authorization: "Bearer " + token };
      const bads = [
        "",
        "short",
        "x".repeat(44),
        "x".repeat(42) + "'",
        "x".repeat(40) + " or 1",
      ];
      for (const bad of bads) {
        const submit = await postMcp(
          url.url,
          { [SUBMIT_HEADER]: bad },
          rpc,
          LAPTOP_PATH,
        );
        expect(submit.status, "submit " + bad).toBe(401);
        if (bad === "") continue;
        const watcher = await postMcp(
          url.url,
          { ...bearer, [WATCHER_HEADER]: machine + "." + bad },
          rpc,
          LAPTOP_PATH,
        );
        expect(watcher.status, "watcher " + bad).toBe(401);
      }
    } finally {
      url.stop();
    }
  });

  test("a revoked watcher credential is refused", async () => {
    const token = await idp.token({ claims: { sub: `rv-${sub}` } });
    const watcher = await registerWatcher(served.url, token);
    const headers = {
      Authorization: `Bearer ${token}`,
      [WATCHER_HEADER]: watcher.header,
    };
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await postMcp(served.url, headers, rpc, LAPTOP_PATH)).status).toBe(
      200,
    );
    const revoke = await fetch(`${served.url}${WATCHER_PATH}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ machineId: watcher.machineId }),
    });
    expect(await revoke.json()).toEqual({ revoked: true });
    expect((await postMcp(served.url, headers, rpc, LAPTOP_PATH)).status).toBe(
      403,
    );
  });

  test("watcher registration needs a token and a valid body", async () => {
    const url = `${served.url}${WATCHER_PATH}`;
    const json = { "Content-Type": "application/json" };
    expect(
      (await fetch(url, { method: "PUT", headers: json, body: "{}" })).status,
    ).toBe(401);
    const token = await idp.token({ claims: { sub: `reg-${sub}` } });
    const headers = { ...json, Authorization: `Bearer ${token}` };
    expect(
      (await fetch(url, { method: "PUT", headers, body: "{}" })).status,
    ).toBe(400);
    expect(
      (await fetch(url, { method: "PUT", headers, body: "not json" })).status,
    ).toBe(400);
    expect((await fetch(url, { method: "GET", headers })).status).toBe(405);
  });
});

describe("mcp access policy", () => {
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

  test("the admin email domain policy never applies to /mcp", async () => {
    const policy = await createHarness({
      config: {
        auth: idp.authConfig({ allowedEmailDomains: ["pressw.test"] }),
        mcp: {
          audiences: ["pw-support-test-client"],
          requiredGroup: undefined,
          perWindow: 50,
          maxBodyBytes: 2048,
        },
      },
    });
    const url = serveApp(policy.app);
    try {
      const token = await idp.token({
        claims: { sub: `noemail-${sub}` },
        omit: ["email"],
      });
      const headers = { Authorization: `Bearer ${token}` };
      const admin = await fetch(`${url.url}/admin/me`, { headers });
      expect(admin.status).toBe(403);
      const mcp = await postMcp(url.url, headers, ping);
      expect(mcp.status).toBe(200);
    } finally {
      url.stop();
      await policy.close();
    }
  });

  test("an authenticated engineer outside MCP_REQUIRED_GROUP gets 403", async () => {
    const policy = await createHarness({
      config: {
        mcp: {
          audiences: ["pw-support-test-client"],
          requiredGroup: "engineers",
          perWindow: 50,
          maxBodyBytes: 2048,
        },
        auth: idp.authConfig(),
      },
    });
    const url = serveApp(policy.app);
    try {
      const outside = await idp.token({ claims: { sub: `out-${sub}` } });
      const inside = await idp.token({
        claims: { sub: `in-${sub}`, "cognito:groups": ["engineers"] },
      });
      const denied = await postMcp(
        url.url,
        { Authorization: `Bearer ${outside}` },
        ping,
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "forbidden" });
      const allowed = await postMcp(
        url.url,
        { Authorization: `Bearer ${inside}` },
        ping,
      );
      expect(allowed.status).toBe(200);
      const missing = await postMcp(url.url, {}, ping);
      expect(missing.status).toBe(401);
    } finally {
      url.stop();
      await policy.close();
    }
  });
});

describe("production mcp configuration", () => {
  const MCP_CLIENT = "pw-support-prod-mcp";
  const rpc = { jsonrpc: "2.0", id: 1, method: "ping" };

  async function productionHarness(extra: Record<string, string>) {
    const adminAudience = idp.authConfig().audiences[0] as string;
    const production = loadConfig({
      NODE_ENV: "production",
      COGNITO_ISSUER: idp.issuer,
      COGNITO_AUDIENCE: adminAudience,
      ...extra,
    });
    const instance = await createHarness({
      config: {
        auth: { ...production.auth, clockToleranceSeconds: 5 },
        mcp: production.mcp,
      },
    });
    return { instance, served: serveApp(instance.app), adminAudience };
  }

  async function expectUnavailable(url: string, token: string) {
    const headers = { Authorization: `Bearer ${token}` };
    for (const path of ["/mcp", LAPTOP_PATH]) {
      const response = await postMcp(url, headers, rpc, path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "mcp_not_configured" });
    }
    const watcher = await fetch(`${url}${WATCHER_PATH}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ machineId: crypto.randomUUID(), secret: "x" }),
    });
    expect(watcher.status).toBe(503);
  }

  test("production with no MCP_AUDIENCE answers 503 on /mcp, /mcp/laptop, and the watcher registration while admin keeps working", async () => {
    const { instance, served: url } = await productionHarness({
      MCP_REQUIRED_GROUP: "engineers",
    });
    try {
      const token = await idp.token({
        claims: { sub: `noaud-${sub}`, "cognito:groups": ["engineers"] },
      });
      await expectUnavailable(url.url, token);
      const admin = await fetch(`${url.url}/admin/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(admin.status).toBe(200);
    } finally {
      url.stop();
      await instance.close();
    }
  });

  test("production with MCP_AUDIENCE but no MCP_REQUIRED_GROUP answers 503", async () => {
    const { instance, served: url } = await productionHarness({
      MCP_AUDIENCE: MCP_CLIENT,
    });
    try {
      const token = await idp.token({
        claims: { sub: `nogroup-${sub}`, aud: MCP_CLIENT },
      });
      await expectUnavailable(url.url, token);
    } finally {
      url.stop();
      await instance.close();
    }
  });

  test("production with both settings accepts the MCP audience with the group and rejects the other tokens", async () => {
    const {
      instance,
      served: url,
      adminAudience,
    } = await productionHarness({
      MCP_AUDIENCE: MCP_CLIENT,
      MCP_REQUIRED_GROUP: "engineers",
    });
    try {
      const allowed = await idp.token({
        claims: {
          sub: `ok-${sub}`,
          aud: MCP_CLIENT,
          "cognito:groups": ["engineers"],
        },
      });
      const adminOnly = await idp.token({
        claims: {
          sub: `adm-${sub}`,
          aud: adminAudience,
          "cognito:groups": ["engineers"],
        },
      });
      const noGroup = await idp.token({
        claims: { sub: `ng-${sub}`, aud: MCP_CLIENT },
      });
      const post = (token: string) =>
        postMcp(url.url, { Authorization: `Bearer ${token}` }, rpc);
      expect((await post(allowed)).status).toBe(200);
      expect((await post(adminOnly)).status).toBe(401);
      expect((await post(noGroup)).status).toBe(403);
    } finally {
      url.stop();
      await instance.close();
    }
  });

  test("outside production the admin audience fallback still reaches /mcp", async () => {
    const local = loadConfig({});
    expect(local.mcp.disabled).toBeUndefined();
    const token = await idp.token({ claims: { sub: `loc-${sub}` } });
    const response = await postMcp(
      served.url,
      { Authorization: `Bearer ${token}` },
      rpc,
    );
    expect(response.status).toBe(200);
  });
});
