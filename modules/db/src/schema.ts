import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const support = pgSchema("support");

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const projects = support.table(
  "projects",
  {
    id: id(),
    clientSlug: text("client_slug").notNull(),
    projectSlug: text("project_slug").notNull(),
    name: text("name").notNull(),
    linearTeamId: text("linear_team_id"),
    createdAt: createdAt(),
  },
  (t) => [unique("projects_client_project_uq").on(t.clientSlug, t.projectSlug)],
);

export const projectKeys = support.table(
  "project_keys",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull().unique("project_keys_key_uq"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("project_keys_project_idx").on(t.projectId)],
);

export const customers = support.table(
  "customers",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    hashedId: text("hashed_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("customers_project_hashed_uq").on(t.projectId, t.hashedId),
    unique("customers_project_id_uq").on(t.projectId, t.id),
  ],
);

export const requests = support.table(
  "requests",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    channelKey: text("channel_key").notNull(),
    status: text("status").notNull().default("open"),
    customerLastReadAt: timestamp("customer_last_read_at", {
      withTimezone: true,
    }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("requests_project_created_idx").on(t.projectId, t.createdAt),
    index("requests_customer_idx").on(t.customerId),
    foreignKey({
      name: "requests_customer_project_fk",
      columns: [t.projectId, t.customerId],
      foreignColumns: [customers.projectId, customers.id],
    }).onDelete("cascade"),
  ],
);

export const messages = support.table(
  "messages",
  {
    id: id(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    bodyFlagged: boolean("body_flagged").notNull().default(false),
    sanitizedBody: text("sanitized_body"),
    originChannel: text("origin_channel").notNull(),
    author: text("author").notNull(),
    authorName: text("author_name"),
    audience: text("audience").notNull(),
    intakeCompletedAt: timestamp("intake_completed_at", {
      withTimezone: true,
    }),
    createdAt: createdAt(),
    insertedAt: timestamp("inserted_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [index("messages_request_created_idx").on(t.requestId, t.createdAt)],
);

export const attachments = support.table(
  "attachments",
  {
    id: id(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    linearDeliveredAt: timestamp("linear_delivered_at", {
      withTimezone: true,
    }),
    createdAt: createdAt(),
  },
  (t) => [index("attachments_message_idx").on(t.messageId)],
);

export const events = support.table(
  "events",
  {
    id: id(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    type: text("type").notNull(),
    channelKey: text("channel_key").notNull(),
    requestId: uuid("request_id"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("events_request_idx").on(t.requestId)],
);

export const attachmentRejections = support.table(
  "attachment_rejections",
  {
    id: id(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("attachment_rejections_message_idx").on(t.messageId)],
);

export const rateLimits = support.table(
  "rate_limits",
  {
    scope: text("scope").notNull(),
    subject: text("subject").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    hits: integer("hits").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.subject, t.windowStart] }),
    index("rate_limits_window_idx").on(t.windowStart),
  ],
);

export const channelDelays = support.table("channel_delays", {
  delayChannel: text("delay_channel").primaryKey(),
  currentDelaySeconds: integer("current_delay_seconds").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const triageJobs = support.table(
  "triage_jobs",
  {
    id: id(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" })
      .unique("triage_jobs_request_uq"),
    channelKey: text("channel_key").notNull(),
    delayChannel: text("delay_channel").notNull(),
    status: text("status").notNull().default("open"),
    cloudAvailableAt: timestamp("cloud_available_at", {
      withTimezone: true,
    }).notNull(),
    intakeCompletedAt: timestamp("intake_completed_at", {
      withTimezone: true,
    }),
    laptopClaimedAt: timestamp("laptop_claimed_at", { withTimezone: true }),
    claimedByKind: text("claimed_by_kind"),
    claimedBy: text("claimed_by"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    outcome: text("outcome"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    agentSessionId: text("agent_session_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("triage_jobs_status_idx").on(t.status, t.cloudAvailableAt)],
);

export const judgments = support.table(
  "judgments",
  {
    id: id(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    score: doublePrecision("score").notNull(),
    threshold: doublePrecision("threshold").notNull(),
    flagged: boolean("flagged").notNull(),
    raw: jsonb("raw")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("judgments_request_idx").on(t.requestId, t.kind)],
);

export const eventCursors = support.table("event_cursors", {
  adapter: text("adapter").primaryKey(),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tickets = support.table("tickets", {
  id: id(),
  requestId: uuid("request_id")
    .notNull()
    .references(() => requests.id, { onDelete: "cascade" })
    .unique("tickets_request_uq"),
  provider: text("provider").notNull().default("linear"),
  linearIssueId: text("linear_issue_id")
    .notNull()
    .unique("tickets_linear_issue_uq"),
  identifier: text("identifier").notNull(),
  url: text("url").notNull(),
  createdAt: createdAt(),
});

export const ticketDeliveries = support.table("ticket_deliveries", {
  requestId: uuid("request_id")
    .primaryKey()
    .references(() => requests.id, { onDelete: "cascade" }),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  lastEnqueuedAt: timestamp("last_enqueued_at", {
    withTimezone: true,
  }).notNull(),
});

export const webhookDeliveries = support.table("webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  provider: text("provider").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const inboundComments = support.table(
  "inbound_comments",
  {
    id: id(),
    provider: text("provider").notNull().default("linear"),
    commentId: text("comment_id").notNull(),
    issueId: text("issue_id").notNull(),
    parentCommentId: text("parent_comment_id"),
    authorId: text("author_id"),
    authorName: text("author_name"),
    body: text("body").notNull(),
    requestId: uuid("request_id").references(() => requests.id, {
      onDelete: "cascade",
    }),
    status: text("status").notNull().default("pending"),
    disposition: text("disposition"),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    refetchRequired: boolean("refetch_required").notNull().default(false),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    createdAt: createdAt(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [unique("inbound_comments_comment_uq").on(t.provider, t.commentId)],
);

export const commentChanges = support.table(
  "comment_changes",
  {
    provider: text("provider").notNull().default("linear"),
    commentId: text("comment_id").notNull(),
    action: text("action").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.commentId] })],
);

export const replies = support.table(
  "replies",
  {
    id: id(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    inboundCommentId: uuid("inbound_comment_id")
      .notNull()
      .references(() => inboundComments.id, { onDelete: "cascade" })
      .unique("replies_inbound_uq"),
    threadRootId: text("thread_root_id").notNull(),
    authorId: text("author_id"),
    authorName: text("author_name"),
    body: text("body").notNull(),
    status: text("status").notNull(),
    holdReason: text("hold_reason"),
    cancelReason: text("cancel_reason"),
    wordingScore: doublePrecision("wording_score").notNull(),
    flagged: boolean("flagged").notNull().default(false),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    confirmedBy: text("confirmed_by"),
    warningCommentId: text("warning_comment_id"),
    cancelNoticeCommentId: text("cancel_notice_comment_id"),
    heldAt: timestamp("held_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("replies_thread_idx").on(t.threadRootId, t.status)],
);

export const messageDeliveries = support.table(
  "message_deliveries",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    via: text("via"),
    linearCommentId: text("linear_comment_id").unique(
      "message_deliveries_comment_uq",
    ),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("message_deliveries_request_idx").on(t.requestId)],
);
