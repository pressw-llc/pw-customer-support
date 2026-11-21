import { afterEach, describe, expect, test } from "bun:test";
import type {
  RequestList as ContractRequestList,
  Thread as ContractThread,
} from "@pw-support/contracts";
import { hashCustomerId } from "@pw-support/contracts";
import { createClient, DEFAULT_API_URL, SupportApiError } from "./client";
import { computeHashedId } from "./hash";
import type { RequestList, Thread } from "./types";

type Assignable<T, U extends T> = U;
export type ListMatchesContract = Assignable<RequestList, ContractRequestList>;
export type ThreadMatchesContract = Assignable<Thread, ContractThread>;

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

interface Seen {
  url: string;
  init: RequestInit;
}

function stub(respond: () => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return seen;
}

const client = (apiUrl = "http://api.test/") =>
  createClient({ apiUrl, projectKey: "pk_acme", userEmail: "ada@acme.test" });

describe("hashing", () => {
  test("matches the contracts helper and a known SHA-256 vector", async () => {
    const hashed = await computeHashedId("ada@acme.test", "pk_acme");
    expect(hashed).toBe(await hashCustomerId("ada@acme.test", "pk_acme"));
    const expected = new Bun.CryptoHasher("sha256")
      .update("ada@acme.testpk_acme")
      .digest("hex");
    expect(hashed).toBe(expected);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("support client", () => {
  test("sends the project key and hashed id on every call", async () => {
    const seen = stub(() => Response.json({ requests: [] }));
    await client().listRequests();
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(seen[0]?.url).toBe("http://api.test/v1/requests");
    expect(headers["X-Support-Key"]).toBe("pk_acme");
    expect(headers["X-Support-User"]).toBe(
      await computeHashedId("ada@acme.test", "pk_acme"),
    );
  });

  test("uses the build-time default api url", async () => {
    expect(DEFAULT_API_URL).toBe("http://localhost:8787");
    const seen = stub(() => Response.json({ requests: [] }));
    await createClient({ projectKey: "k", userEmail: "e" }).listRequests();
    expect(seen[0]?.url).toBe("http://localhost:8787/v1/requests");
  });

  test("builds multipart bodies for create and reply", async () => {
    const seen = stub(() => Response.json({ requestId: "r", files: [] }));
    const file = new File(["abc"], "a.txt");
    await client().createRequest("hello", [file]);
    await client().reply("r 1", "again", []);
    const created = seen[0]?.init.body as FormData;
    expect(seen[0]?.init.method).toBe("POST");
    expect(created.get("text")).toBe("hello");
    expect((created.getAll("files")[0] as File).name).toBe("a.txt");
    expect(seen[1]?.url).toBe("http://api.test/v1/requests/r%201/messages");
    const reply = seen[1]?.init.body as FormData;
    expect(reply.get("text")).toBe("again");
  });

  test("reads a thread, marks it read, and downloads an attachment", async () => {
    const seen = stub(() => new Response("bytes"));
    await client().markRead("r1");
    const blob = await client().downloadAttachment("a1");
    expect(await blob.text()).toBe("bytes");
    expect(seen.map((call) => call.url)).toEqual([
      "http://api.test/v1/requests/r1/read",
      "http://api.test/v1/attachments/a1",
    ]);
    stub(() => Response.json({ id: "r1", messages: [] }));
    expect((await client().getThread("r1")).id).toBe("r1");
  });

  test("maps an error response to SupportApiError with the code", async () => {
    stub(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    const error = await client()
      .listRequests()
      .catch((failure) => failure);
    expect(error).toBeInstanceOf(SupportApiError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  test("keeps Retry-After from a 429", async () => {
    stub(() =>
      Response.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": "12" } },
      ),
    );
    const error = await client()
      .listRequests()
      .catch((failure) => failure);
    expect(error.retryAfterSeconds).toBe(12);
  });

  test("an unparseable error body becomes an unknown code", async () => {
    stub(() => new Response("<html>", { status: 502 }));
    const error = await client()
      .listRequests()
      .catch((failure) => failure);
    expect(error.status).toBe(502);
    expect(error.code).toBe("unknown");
  });

  test("a network failure becomes status 0", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new TypeError("offline"))) as unknown as typeof fetch;
    const error = await client()
      .listRequests()
      .catch((failure) => failure);
    expect(error.status).toBe(0);
    expect(error.code).toBe("network");
  });
});
