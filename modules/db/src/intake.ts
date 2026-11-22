import {
  type AttachmentRejectionReason,
  formatChannelKey,
  PREVIEW_CHARS,
} from "@pw-support/contracts";
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { SupportDb, SupportExecutor } from "./client";
import { appendEvent } from "./events";
import type { Project } from "./projects";
import {
  attachmentRejections,
  attachments,
  customers,
  messages,
  requests,
} from "./schema";
import { type JobOptions, openTriageJob, type TriageJob } from "./triage-jobs";

export type Customer = typeof customers.$inferSelect;
export type RequestRow = typeof requests.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;

export interface CustomerScope {
  project: Project;
  customer: Customer;
}

const CUSTOMER_VISIBLE = "external";

function required<T>(row: T | undefined): T {
  if (row === undefined) throw new Error("expected a row");
  return row;
}

export async function upsertCustomer(
  db: SupportExecutor,
  projectId: string,
  hashedId: string,
): Promise<Customer> {
  const [row] = await db
    .insert(customers)
    .values({ projectId, hashedId })
    .onConflictDoUpdate({
      target: [customers.projectId, customers.hashedId],
      set: { hashedId: sql`excluded.hashed_id` },
    })
    .returning();
  return required(row);
}

export interface InboundRequest {
  scope: CustomerScope;
  body: string;
}

export async function persistInboundRequest(
  db: SupportDb,
  input: InboundRequest,
  jobOptions: JobOptions = {},
): Promise<{
  request: RequestRow;
  message: MessageRow;
  job: TriageJob;
  delaySeconds: number;
}> {
  const { project, customer } = input.scope;
  const channelKey = formatChannelKey({
    client: project.clientSlug,
    project: project.projectSlug,
    user: customer.hashedId,
  });
  return db.transaction(async (tx) => {
    const [request] = await tx
      .insert(requests)
      .values({ projectId: project.id, customerId: customer.id, channelKey })
      .returning();
    const created = required(request);
    const [message] = await tx
      .insert(messages)
      .values({
        requestId: created.id,
        body: input.body,
        originChannel: "widget",
        author: "customer",
        audience: CUSTOMER_VISIBLE,
      })
      .returning();
    const first = required(message);
    await appendEvent(tx, {
      type: "request.created",
      channelKey,
      requestId: created.id,
      payload: { messageId: first.id, originChannel: "widget" },
    });
    const { job, delaySeconds } = await openTriageJob(tx, created, jobOptions);
    return { request: created, message: first, job, delaySeconds };
  });
}

export interface InboundMessage {
  scope: CustomerScope;
  requestId: string;
  body: string;
}

export async function findCustomerRequest(
  db: SupportExecutor,
  scope: CustomerScope,
  requestId: string,
): Promise<RequestRow | null> {
  const [row] = await db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.id, requestId),
        eq(requests.projectId, scope.project.id),
        eq(requests.customerId, scope.customer.id),
      ),
    );
  return row ?? null;
}

export async function persistInboundMessage(
  db: SupportDb,
  input: InboundMessage,
): Promise<{ request: RequestRow; message: MessageRow } | null> {
  return db.transaction(async (tx) => {
    const request = await findCustomerRequest(tx, input.scope, input.requestId);
    if (!request) return null;
    const [row] = await tx
      .insert(messages)
      .values({
        requestId: request.id,
        body: input.body,
        originChannel: "widget",
        author: "customer",
        audience: CUSTOMER_VISIBLE,
      })
      .returning();
    const message = required(row);
    await tx
      .update(requests)
      .set({ updatedAt: sql`now()` })
      .where(eq(requests.id, request.id));
    await appendEvent(tx, {
      type: "message.created",
      channelKey: request.channelKey,
      requestId: request.id,
      payload: {
        messageId: message.id,
        originChannel: "widget",
        author: "customer",
      },
    });
    return { request, message };
  });
}

export interface MessageChecks {
  message: MessageRow;
  request: RequestRow;
  sanitizedBody: string;
  flagged: boolean;
  reasons: string[];
}

export async function recordMessageChecks(
  db: SupportDb,
  input: MessageChecks,
): Promise<MessageRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(messages)
      .set({ sanitizedBody: input.sanitizedBody, bodyFlagged: input.flagged })
      .where(eq(messages.id, input.message.id))
      .returning();
    if (input.flagged) {
      await appendEvent(tx, {
        type: "message.flagged",
        channelKey: input.request.channelKey,
        requestId: input.request.id,
        payload: { messageId: input.message.id, reasons: input.reasons },
      });
    }
    return required(row);
  });
}

export interface StoredAttachment {
  messageId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
  sha256: string;
}

export async function recordAttachment(
  db: SupportExecutor,
  input: StoredAttachment,
): Promise<AttachmentRow> {
  const [row] = await db.insert(attachments).values(input).returning();
  return required(row);
}

export interface RejectedAttachment {
  message: MessageRow;
  request: RequestRow;
  filename: string;
  sizeBytes: number;
  reason: AttachmentRejectionReason;
}

export async function recordAttachmentRejection(
  db: SupportDb,
  input: RejectedAttachment,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(attachmentRejections).values({
      messageId: input.message.id,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      reason: input.reason,
    });
    await appendEvent(tx, {
      type: "attachment.rejected",
      channelKey: input.request.channelKey,
      requestId: input.request.id,
      payload: {
        messageId: input.message.id,
        filename: input.filename,
        sizeBytes: input.sizeBytes,
        reason: input.reason,
      },
    });
  });
}

export interface RequestListItem {
  request: RequestRow;
  unreadCount: number;
  lastMessage: {
    preview: string;
    author: string;
    originChannel: string;
    createdAt: Date;
  } | null;
}

export function displayBody(message: {
  body: string;
  sanitizedBody: string | null;
}): string {
  return message.sanitizedBody ?? message.body;
}

export async function listCustomerRequests(
  db: SupportExecutor,
  scope: CustomerScope,
): Promise<RequestListItem[]> {
  const rows = await db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.projectId, scope.project.id),
        eq(requests.customerId, scope.customer.id),
      ),
    )
    .orderBy(desc(requests.updatedAt), asc(requests.id));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const latest = await db
    .selectDistinctOn([messages.requestId], {
      requestId: messages.requestId,
      body: messages.body,
      sanitizedBody: messages.sanitizedBody,
      author: messages.author,
      originChannel: messages.originChannel,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        inArray(messages.requestId, ids),
        eq(messages.audience, CUSTOMER_VISIBLE),
      ),
    )
    .orderBy(messages.requestId, desc(messages.createdAt), desc(messages.id));
  const unread = await db
    .select({
      requestId: messages.requestId,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(requests, eq(requests.id, messages.requestId))
    .where(
      and(
        inArray(messages.requestId, ids),
        eq(messages.audience, CUSTOMER_VISIBLE),
        ne(messages.author, "customer"),
        gt(
          messages.insertedAt,
          sql`coalesce(${requests.customerLastReadAt}, '-infinity'::timestamptz)`,
        ),
      ),
    )
    .groupBy(messages.requestId);
  const latestById = new Map(latest.map((row) => [row.requestId, row]));
  const unreadById = new Map(unread.map((row) => [row.requestId, row.count]));
  return rows.map((request) => {
    const last = latestById.get(request.id);
    return {
      request,
      unreadCount: unreadById.get(request.id) ?? 0,
      lastMessage: last
        ? {
            preview: displayBody(last).slice(0, PREVIEW_CHARS),
            author: last.author,
            originChannel: last.originChannel,
            createdAt: last.createdAt,
          }
        : null,
    };
  });
}

export interface ThreadRows {
  request: RequestRow;
  messages: { message: MessageRow; attachments: AttachmentRow[] }[];
}

export async function getCustomerThread(
  db: SupportExecutor,
  scope: CustomerScope,
  requestId: string,
): Promise<ThreadRows | null> {
  const request = await findCustomerRequest(db, scope, requestId);
  if (!request) return null;
  const visible = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.requestId, request.id),
        eq(messages.audience, CUSTOMER_VISIBLE),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const files =
    visible.length === 0
      ? []
      : await db
          .select()
          .from(attachments)
          .where(
            inArray(
              attachments.messageId,
              visible.map((message) => message.id),
            ),
          )
          .orderBy(asc(attachments.createdAt), asc(attachments.id));
  return {
    request,
    messages: visible.map((message) => ({
      message,
      attachments: files.filter((file) => file.messageId === message.id),
    })),
  };
}

export async function markThreadRead(
  db: SupportExecutor,
  scope: CustomerScope,
  requestId: string,
): Promise<boolean> {
  const rows = await db
    .update(requests)
    .set({ customerLastReadAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(requests.id, requestId),
        eq(requests.projectId, scope.project.id),
        eq(requests.customerId, scope.customer.id),
      ),
    )
    .returning({ id: requests.id });
  return rows.length > 0;
}

export async function getCustomerAttachment(
  db: SupportExecutor,
  scope: CustomerScope,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const [row] = await db
    .select({ attachment: attachments })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(requests, eq(requests.id, messages.requestId))
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(messages.audience, CUSTOMER_VISIBLE),
        eq(requests.projectId, scope.project.id),
        eq(requests.customerId, scope.customer.id),
      ),
    );
  return row?.attachment ?? null;
}
