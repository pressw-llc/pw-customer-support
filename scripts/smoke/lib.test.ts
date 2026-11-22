import { describe, expect, test } from "bun:test";
import {
  archiveTicket,
  linearReadback,
  runSmoke,
  SmokeError,
  type Ticket,
} from "./lib";

const ticket: Ticket = {
  id: "i1",
  identifier: "SUP-1",
  url: "https://linear/SUP-1",
};

function apiFetcher(status: number, calls: Request[] = []): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    calls.push(new Request(String(input), init));
    return Response.json({ requestId: "req-1" }, { status });
  }) as typeof fetch;
}

describe("runSmoke", () => {
  test("submits one request with the project key and a hashed id, then finds the ticket", async () => {
    const calls: Request[] = [];
    let attempts = 0;
    let seenToken = "";
    const result = await runSmoke({
      apiUrl: "https://api.example.test/",
      projectKey: "pk_smoke",
      fetcher: apiFetcher(201, calls),
      readback: async (token) => {
        seenToken = token;
        attempts += 1;
        return attempts >= 3 ? ticket : undefined;
      },
      intervalMs: 1,
      sleep: async () => {},
    });
    expect(result.requestId).toBe("req-1");
    expect(result.ticket).toEqual(ticket);
    expect(result.token).toBe(seenToken);
    expect(attempts).toBe(3);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Request;
    expect(call.url).toBe("https://api.example.test/v1/requests");
    expect(call.headers.get("x-support-key")).toBe("pk_smoke");
    expect(call.headers.get("x-support-user")).toMatch(/^[0-9a-f]{64}$/);
    const form = await call.formData();
    expect(String(form.get("text"))).toContain(seenToken);
  });

  test("fails at submit when the API refuses", async () => {
    const error = await runSmoke({
      apiUrl: "https://api.example.test",
      projectKey: "k",
      fetcher: apiFetcher(401),
      readback: async () => undefined,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(SmokeError);
    expect(error.step).toBe("submit");
    expect(error.message).toContain("401");
  });

  test("fails at readback after the timeout and tolerates a readback error", async () => {
    let clock = 0;
    const error = await runSmoke({
      apiUrl: "https://api.example.test",
      projectKey: "k",
      email: "smoke@example.invalid",
      fetcher: apiFetcher(201),
      readback: async () => {
        throw new Error("linear down");
      },
      timeoutMs: 30,
      intervalMs: 10,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }).catch((e) => e);
    expect(error.step).toBe("readback");
    expect(error.message).toContain("no Linear ticket");
  });

  test("returns an undefined request id when the body has none", async () => {
    const fetcher = (async () =>
      new Response("not json", { status: 201 })) as unknown as typeof fetch;
    const result = await runSmoke({
      apiUrl: "https://api.example.test",
      projectKey: "k",
      fetcher,
      readback: async () => ticket,
    });
    expect(result.requestId).toBeUndefined();
  });
});

describe("Linear readback and archive", () => {
  function linear(handler: (query: string) => unknown, status = 200) {
    const seen: { auth: string | null; query: string; vars: unknown }[] = [];
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push({
        auth: new Headers(init?.headers).get("authorization"),
        query: body.query,
        vars: body.variables,
      });
      return Response.json({ data: handler(body.query) }, { status });
    }) as unknown as typeof fetch;
    return { fetcher, seen };
  }

  test("searches issues by the token with a raw API key header", async () => {
    const { fetcher, seen } = linear(() => ({ issues: { nodes: [ticket] } }));
    const readback = linearReadback({
      url: "https://linear",
      apiKey: "lin_key",
      teamId: "team-1",
      fetcher,
    });
    expect(await readback("smoke-1")).toEqual(ticket);
    expect(seen[0]?.auth).toBe("lin_key");
    expect(seen[0]?.vars).toEqual({ teamId: "team-1", marker: "smoke-1" });
  });

  test("returns nothing when no issue matches and rejects on HTTP errors", async () => {
    const empty = linear(() => ({ issues: { nodes: [] } }));
    expect(
      await linearReadback({
        url: "u",
        apiKey: "k",
        teamId: "t",
        fetcher: empty.fetcher,
      })("t"),
    ).toBeUndefined();
    const broken = linear(() => ({}), 500);
    await expect(
      linearReadback({
        url: "u",
        apiKey: "k",
        teamId: "t",
        fetcher: broken.fetcher,
      })("t"),
    ).rejects.toThrow("linear 500");
  });

  test("archives a ticket and reports failure", async () => {
    const ok = linear(() => ({ issueArchive: { success: true } }));
    expect(
      await archiveTicket({
        url: "u",
        apiKey: "k",
        ticketId: "i1",
        fetcher: ok.fetcher,
      }),
    ).toBe(true);
    const no = linear(() => ({ issueArchive: { success: false } }));
    expect(
      await archiveTicket({
        url: "u",
        apiKey: "k",
        ticketId: "i1",
        fetcher: no.fetcher,
      }),
    ).toBe(false);
  });
});
