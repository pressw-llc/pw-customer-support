import { computeHashedId } from "./hash";
import type { IntakeResult, RequestList, Thread } from "./types";

declare const __SUPPORT_API_URL__: string;

export const DEFAULT_API_URL: string =
  typeof __SUPPORT_API_URL__ === "string"
    ? __SUPPORT_API_URL__
    : "http://localhost:8787";

export class SupportApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`support api error ${status} ${code}`);
  }
}

export interface ClientOptions {
  apiUrl?: string;
  projectKey: string;
  userEmail: string;
}

export function createClient(options: ClientOptions) {
  const base = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const hashedId = computeHashedId(options.userEmail, options.projectKey);

  async function send(
    method: string,
    path: string,
    body?: FormData,
  ): Promise<Response> {
    const headers = {
      "X-Support-Key": options.projectKey,
      "X-Support-User": await hashedId,
    };
    let response: Response;
    try {
      response = await fetch(`${base}/v1${path}`, { method, headers, body });
    } catch {
      throw new SupportApiError(0, "network");
    }
    if (response.ok) return response;
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    const retry = Number(response.headers.get("Retry-After"));
    throw new SupportApiError(
      response.status,
      payload.error ?? "unknown",
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }

  async function json<T>(
    method: string,
    path: string,
    body?: FormData,
  ): Promise<T> {
    return (await (await send(method, path, body)).json()) as T;
  }

  function composeForm(text: string, files: File[]): FormData {
    const form = new FormData();
    form.set("text", text);
    for (const file of files) form.append("files", file, file.name);
    return form;
  }

  return {
    listRequests: () => json<RequestList>("GET", "/requests"),
    getThread: (id: string) =>
      json<Thread>("GET", `/requests/${encodeURIComponent(id)}`),
    createRequest: (text: string, files: File[]) =>
      json<IntakeResult>("POST", "/requests", composeForm(text, files)),
    reply: (id: string, text: string, files: File[]) =>
      json<IntakeResult>(
        "POST",
        `/requests/${encodeURIComponent(id)}/messages`,
        composeForm(text, files),
      ),
    markRead: async (id: string) => {
      await send("POST", `/requests/${encodeURIComponent(id)}/read`);
    },
    downloadAttachment: async (id: string) =>
      (await send("GET", `/attachments/${encodeURIComponent(id)}`)).blob(),
  };
}

export type SupportClient = ReturnType<typeof createClient>;
