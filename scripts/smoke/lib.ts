import { hashCustomerId } from "@pw-support/contracts";

export interface Ticket {
  id: string;
  identifier: string;
  url: string;
}

export type Readback = (token: string) => Promise<Ticket | undefined>;

export interface SmokeOptions {
  apiUrl: string;
  projectKey: string;
  readback: Readback;
  email?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SmokeResult {
  requestId: string | undefined;
  token: string;
  ticket: Ticket;
}

export class SmokeError extends Error {
  constructor(
    message: string,
    readonly step: "submit" | "readback",
  ) {
    super(message);
    this.name = "SmokeError";
  }
}

export const DEFAULT_SMOKE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_SMOKE_INTERVAL_MS = 5_000;

export async function submitSmokeRequest(options: {
  apiUrl: string;
  projectKey: string;
  email: string;
  token: string;
  fetcher: typeof fetch;
}): Promise<string | undefined> {
  const form = new FormData();
  form.set(
    "text",
    `Smoke test ${options.token}. This ticket is created by the deploy smoke check and can be archived.`,
  );
  const response = await options.fetcher(
    `${options.apiUrl.replace(/\/+$/, "")}/v1/requests`,
    {
      method: "POST",
      headers: {
        "X-Support-Key": options.projectKey,
        "X-Support-User": await hashCustomerId(
          options.email,
          options.projectKey,
        ),
      },
      body: form,
    },
  );
  if (response.status !== 201) {
    throw new SmokeError(
      `submit returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
      "submit",
    );
  }
  const body = (await response.json().catch(() => ({}))) as { id?: string };
  return body.id;
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const token = `smoke-${crypto.randomUUID().slice(0, 12)}`;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const requestId = await submitSmokeRequest({
    apiUrl: options.apiUrl,
    projectKey: options.projectKey,
    email: options.email ?? `smoke+${token}@example.invalid`,
    token,
    fetcher,
  });

  const deadline = now() + (options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS);
  while (now() < deadline) {
    const ticket = await options.readback(token).catch(() => undefined);
    if (ticket) return { requestId, token, ticket };
    await sleep(options.intervalMs ?? DEFAULT_SMOKE_INTERVAL_MS);
  }
  throw new SmokeError(
    `no Linear ticket carried ${token} before the timeout`,
    "readback",
  );
}

const SEARCH = `query SmokeSearch($term: String!) {
  issues(filter: { description: { contains: $term } }, first: 1) {
    nodes { id identifier url }
  }
}`;

const ARCHIVE = `mutation SmokeArchive($id: String!) {
  issueArchive(id: $id) { success }
}`;

async function graphql(
  fetcher: typeof fetch,
  url: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown> }> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`linear ${response.status}`);
  return (await response.json()) as { data?: Record<string, unknown> };
}

export function linearReadback(options: {
  url: string;
  apiKey: string;
  fetcher?: typeof fetch;
}): Readback {
  const fetcher = options.fetcher ?? fetch;
  return async (token) => {
    const result = await graphql(fetcher, options.url, options.apiKey, SEARCH, {
      term: token,
    });
    const nodes = (result.data?.issues as { nodes?: Ticket[] } | undefined)
      ?.nodes;
    return nodes?.[0];
  };
}

export async function archiveTicket(options: {
  url: string;
  apiKey: string;
  ticketId: string;
  fetcher?: typeof fetch;
}): Promise<boolean> {
  const result = await graphql(
    options.fetcher ?? fetch,
    options.url,
    options.apiKey,
    ARCHIVE,
    { id: options.ticketId },
  );
  const archive = result.data?.issueArchive as
    | { success?: boolean }
    | undefined;
  return archive?.success === true;
}
