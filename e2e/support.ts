import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { hashCustomerId } from "@pw-support/contracts";
import {
  attachments,
  closeDb,
  createDb,
  customers,
  events,
  findProjectByKey,
  inboundComments,
  messages,
  requests,
} from "@pw-support/db";
import { and, eq } from "drizzle-orm";
import { E2E } from "./playwright.config";

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(here, "artifacts");

export const uniqueEmail = (): string =>
  `user-${crypto.randomUUID().slice(0, 8)}@acme.test`;

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: resolve(artifacts, `${name}.png`) });
}

export function widgetHost(page: Page): Locator {
  return page.locator("[data-pressw-support]");
}

export async function openPanel(
  page: Page,
  email: string,
  pollMs?: number,
): Promise<void> {
  const poll = pollMs ? `&poll=${pollMs}` : "";
  await page.goto(`/?email=${encodeURIComponent(email)}${poll}`);
  await page.getByRole("button", { name: /open support/i }).click();
  await page.getByRole("dialog").waitFor();
}

export async function startNewRequest(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New request" }).click();
  await page.getByLabel("How can we help?").waitFor();
}

export const elfBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
    Buffer.alloc(64, 1),
  ]);

export const pngBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 1),
  ]);

export async function databaseView(email: string) {
  const db = createDb();
  try {
    const resolved = await findProjectByKey(db, E2E.projectKey);
    if (!resolved) throw new Error("e2e project is not seeded");
    const hashedId = await hashCustomerId(email, E2E.projectKey);
    const [customer] = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.projectId, resolved.project.id),
          eq(customers.hashedId, hashedId),
        ),
      );
    const customerRequests = customer
      ? await db
          .select()
          .from(requests)
          .where(eq(requests.customerId, customer.id))
      : [];
    const requestId = customerRequests[0]?.id;
    const files = requestId
      ? await db
          .select({ filename: attachments.filename })
          .from(attachments)
          .innerJoin(messages, eq(messages.id, attachments.messageId))
          .where(eq(messages.requestId, requestId))
      : [];
    const requestEvents = requestId
      ? await db.select().from(events).where(eq(events.requestId, requestId))
      : [];
    return {
      projectId: resolved.project.id,
      requestId,
      requestCount: customerRequests.length,
      filenames: files.map((file) => file.filename).sort(),
      eventTypes: requestEvents.map((event) => event.type),
    };
  } finally {
    await closeDb(db);
  }
}

const control = `http://127.0.0.1:${E2E.controlPort}`;

export interface StubIssueView {
  id: string;
  identifier: string;
  title: string;
  description: string;
}

export interface StubCommentView {
  id: string;
  body: string;
  parentId: string | null;
  userId: string;
}

async function poll<T>(
  read: () => Promise<T | undefined>,
  what: string,
  ms = 30_000,
): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function waitForIssue(snippet: string): Promise<StubIssueView> {
  return poll(async () => {
    const response = await fetch(`${control}/issues`);
    const issues = (await response.json()) as StubIssueView[];
    return issues.find((issue) => issue.description.includes(snippet));
  }, `a stub ticket containing ${snippet}`);
}

export async function stubComments(
  issueId: string,
): Promise<StubCommentView[]> {
  const response = await fetch(
    `${control}/comments?issueId=${encodeURIComponent(issueId)}`,
  );
  return (await response.json()) as StubCommentView[];
}

export function waitForStubComment(
  issueId: string,
  matches: (comment: StubCommentView) => boolean,
): Promise<StubCommentView> {
  return poll(
    async () => (await stubComments(issueId)).find(matches),
    "a stub comment",
  );
}

export async function postStaffComment(
  issueId: string,
  body: string,
  parentId?: string,
): Promise<StubCommentView> {
  const response = await fetch(`${control}/staff-comment`, {
    method: "POST",
    body: JSON.stringify({ issueId, body, parentId }),
  });
  const result = (await response.json()) as {
    comment: StubCommentView;
    delivery: { status: number } | null;
  };
  if (result.delivery?.status !== 200) {
    throw new Error(`webhook answered ${result.delivery?.status}`);
  }
  return result.comment;
}

export async function waitForInboundProcessed(
  requestId: string,
  count: number,
): Promise<string[]> {
  const db = createDb();
  try {
    return await poll(async () => {
      const rows = await db
        .select()
        .from(inboundComments)
        .where(
          and(
            eq(inboundComments.requestId, requestId),
            eq(inboundComments.status, "processed"),
          ),
        );
      return rows.length >= count
        ? rows.map((row) => row.disposition ?? "")
        : undefined;
    }, `${count} processed inbound comments`);
  } finally {
    await closeDb(db);
  }
}

export async function insertStaffReply(
  requestId: string,
  body: string,
): Promise<void> {
  const db = createDb();
  try {
    await db.insert(messages).values({
      requestId,
      body,
      originChannel: "slack",
      author: "staff",
      audience: "external",
    });
  } finally {
    await closeDb(db);
  }
}
