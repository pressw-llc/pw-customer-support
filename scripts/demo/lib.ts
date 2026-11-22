export const DEMO_CLIENT = "acme";
export const DEMO_PROJECT = "demo";
export const DEMO_KEY = "pk_demo_acme_portal";
export const DEMO_EMAIL = "ada@acme.test";
export const DEMO_WEBHOOK_SECRET = "whsec_demo_local";
export const DEMO_TICKET_PREFIX = "ACME";

export interface DemoPorts {
  api: number;
  stub: number;
  viewer: number;
  admin: number;
  host: number;
}

export interface DemoState {
  ports: DemoPorts;
  pids: Record<string, number>;
  startedStack: boolean;
  startedAt: string;
}

export interface DemoUrls {
  api: string;
  admin: string;
  host: string;
  viewer: string;
  issuer: string;
}

export function demoUrls(ports: DemoPorts, oidcPort: string): DemoUrls {
  return {
    api: `http://127.0.0.1:${ports.api}`,
    admin: `http://127.0.0.1:${ports.admin}`,
    host: `http://127.0.0.1:${ports.host}/?email=${DEMO_EMAIL}&poll=2000`,
    viewer: `http://127.0.0.1:${ports.viewer}`,
    issuer: `http://127.0.0.1:${oidcPort}/support`,
  };
}

export function degradedNotes(
  env: Record<string, string | undefined>,
): string[] {
  const notes: string[] = [];
  if (!env.TYPESAFE_API_KEY) {
    notes.push(
      "TYPESAFE_API_KEY is not set, so Jev is unavailable. The injection filter fails closed: every request goes to human triage. The ticket still appears, labeled for human triage. An @external reply cannot be scored, so it is held until its author confirms with @confirm.",
    );
  }
  if (!env.TRIAGE_AGENT_ID || !env.ANTHROPIC_API_KEY) {
    notes.push(
      "No synced triage agent or ANTHROPIC_API_KEY is set. The demo runs no managed agent, so tickets carry the human triage result and no agent summary.",
    );
  }
  return notes;
}

export function walkthrough(urls: DemoUrls): string[] {
  return [
    `Open the host app at ${urls.host}. Click the support launcher.`,
    "Submit a request with a short message and attach a small image or text file.",
    `Watch triage at ${urls.viewer}. The page refreshes every 3 seconds. A ticket ${DEMO_TICKET_PREFIX}-1 appears within about 10 seconds.`,
    `Post an internal comment as staff: bun run demo comment ${DEMO_TICKET_PREFIX}-1 "Looking at the logs now."`,
    "Check the widget. The internal comment never appears and the unread badge stays off.",
    `Post a customer reply as staff: bun run demo comment ${DEMO_TICKET_PREFIX}-1 "@external We found the cause and a fix ships today."`,
    "Check the widget within a few seconds. The reply appears with the staff name and the unread badge shows. Open the thread to clear it.",
    "Reply as the customer in the thread. The reply appears as a comment on the ticket in the stub viewer.",
    `Open the admin app at ${urls.admin}. Sign in with any user name at the mock issuer. Review the request list, the acknowledgement timer, and a request detail with held or flagged replies.`,
    `Post a second reply, for example bun run demo comment ${DEMO_TICKET_PREFIX}-1 "@external hey, whatever, check back later". A low wording score holds it. The author releases it with @confirm in the thread.`,
    "Open Settings in the admin app to see the project, its key, the Linear team, and the CC list.",
    "Stop everything with: bun run demo stop",
  ];
}

export function parseState(raw: string): DemoState | undefined {
  try {
    const value = JSON.parse(raw) as Partial<DemoState>;
    if (!value.ports || !value.pids) return undefined;
    return value as DemoState;
  } catch {
    return undefined;
  }
}

export function isAlive(
  pid: number,
  kill: typeof process.kill = process.kill,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function commentRequest(args: string[]): {
  identifier: string;
  body: string;
} {
  const [identifier, ...rest] = args;
  const body = rest.join(" ").trim();
  if (!identifier || !body) {
    throw new Error('usage: bun run demo comment <ticket> "<text>"');
  }
  return { identifier, body };
}
