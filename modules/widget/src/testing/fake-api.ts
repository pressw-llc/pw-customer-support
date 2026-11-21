import type {
  FileResult,
  RequestSummary,
  Thread,
  ThreadMessage,
} from "../types";

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: FormData | undefined;
}

export interface FakeApi {
  requests: RequestSummary[];
  threads: Record<string, Thread>;
  calls: RecordedCall[];
  createFiles: FileResult[];
  failWith: number | null;
  restore(): void;
}

const NOW = "2026-01-01T12:00:00.000Z";

export function message(
  id: string,
  body: string,
  overrides: Partial<ThreadMessage> = {},
): ThreadMessage {
  return {
    id,
    body,
    flagged: false,
    author: "customer",
    audience: "external",
    originChannel: "widget",
    createdAt: NOW,
    attachments: [],
    ...overrides,
  };
}

export function summary(
  id: string,
  preview: string,
  overrides: Partial<RequestSummary> = {},
): RequestSummary {
  return {
    id,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
    unreadCount: 0,
    lastMessage: {
      preview,
      author: "customer",
      originChannel: "widget",
      createdAt: NOW,
    },
    ...overrides,
  };
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export function installFakeApi(): FakeApi {
  const original = globalThis.fetch;
  let counter = 0;
  const api: FakeApi = {
    requests: [],
    threads: {},
    calls: [],
    createFiles: [],
    failWith: null,
    restore: () => {
      globalThis.fetch = original;
    },
  };

  function handle(call: RecordedCall): Response {
    if (api.failWith !== null) {
      const retry: Record<string, string> =
        api.failWith === 429 ? { "Retry-After": "7" } : {};
      return json({ error: "failure" }, api.failWith, retry);
    }
    const parts = call.path.split("/").filter(Boolean);
    const [, resource, id, action] = parts;
    if (resource === "attachments") {
      return new Response(new Blob(["file-bytes"]), { status: 200 });
    }
    if (call.method === "GET" && !id) return json({ requests: api.requests });
    if (call.method === "POST" && !id) {
      const text = String(call.body?.get("text"));
      const requestId = `new-${++counter}`;
      const first = message(`m-${requestId}`, text);
      api.threads[requestId] = {
        id: requestId,
        status: "open",
        createdAt: NOW,
        messages: [first],
      };
      api.requests = [summary(requestId, text), ...api.requests];
      return json({ requestId, message: first, files: api.createFiles }, 201);
    }
    const thread = id ? api.threads[id] : undefined;
    if (!thread) return json({ error: "not_found" }, 404);
    if (call.method === "GET") return json(thread);
    if (action === "read") {
      api.requests = api.requests.map((request) =>
        request.id === id ? { ...request, unreadCount: 0 } : request,
      );
      return json({ ok: true });
    }
    const reply = message(`m-${++counter}`, String(call.body?.get("text")));
    thread.messages.push(reply);
    return json({ requestId: id, message: reply, files: api.createFiles }, 201);
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      path: url.pathname,
      headers: init?.headers as Record<string, string>,
      body: init?.body as FormData | undefined,
    };
    api.calls.push(call);
    return handle(call);
  }) as typeof fetch;
  return api;
}
