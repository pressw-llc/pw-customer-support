import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgSchema,
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
  (t) => [unique("customers_project_hashed_uq").on(t.projectId, t.hashedId)],
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
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("requests_project_created_idx").on(t.projectId, t.createdAt),
    index("requests_customer_idx").on(t.customerId),
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
    originChannel: text("origin_channel").notNull(),
    author: text("author").notNull(),
    audience: text("audience").notNull(),
    createdAt: createdAt(),
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
