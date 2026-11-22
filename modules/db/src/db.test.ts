import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, sql as dsql, eq, gt } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
  appendEvent,
  attachments,
  closeDb,
  createDb,
  customers,
  events,
  listMigrations,
  localDatabaseUrl,
  messages,
  migrate,
  projectKeys,
  projects,
  requests,
  resolveDatabaseUrl,
} from "./index";

const db = createDb();
const slug = `acme-${crypto.randomUUID().slice(0, 8)}`;

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

async function seedRequest() {
  const project = first(
    await db
      .insert(projects)
      .values({
        clientSlug: slug,
        projectSlug: crypto.randomUUID(),
        name: "Portal",
      })
      .returning(),
  );
  const customer = first(
    await db
      .insert(customers)
      .values({ projectId: project.id, hashedId: "a".repeat(64) })
      .returning(),
  );
  const request = first(
    await db
      .insert(requests)
      .values({
        projectId: project.id,
        customerId: customer.id,
        channelKey: `${slug}:portal`,
      })
      .returning(),
  );
  return { project, customer, request };
}

const settle = <T>(query: PromiseLike<T>) => Promise.resolve(query);

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.clientSlug, slug));
  await closeDb(db);
});

describe("migrate", () => {
  test("is idempotent and tracks every file", async () => {
    expect(await migrate()).toEqual([]);
    const sql = postgres(resolveDatabaseUrl(), { max: 1 });
    const rows = await sql<{ name: string }[]>`
      SELECT name FROM support.schema_migrations ORDER BY name`;
    await sql.end();
    const names = rows.map((row) => row.name).sort();
    expect(names).toEqual(
      listMigrations()
        .map((file) => file.name)
        .sort(),
    );
    expect(names).toContain("pipeline/0002_pipeline_definitions.sql");
    expect(names).toContain("0001_support_schema.sql");
  });

  test("creates the pipeline tables with a neutral tenant default", async () => {
    const sql = postgres(resolveDatabaseUrl(), { max: 1 });
    const [column] = await sql<{ column_default: string }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'pipeline_definition' AND column_name = 'tenant_id'`;
    await sql.end();
    expect(column?.column_default).toContain("pw-support");
  });
});

describe("url resolution", () => {
  test("builds the local url from the port", () => {
    expect(localDatabaseUrl({})).toBe(
      "postgres://support:support@127.0.0.1:5447/support",
    );
    expect(localDatabaseUrl({ SUPPORT_POSTGRES_PORT: "6000" })).toContain(
      ":6000/",
    );
  });

  test("prefers an explicit url, then DATABASE_URL, then the local url", () => {
    expect(
      resolveDatabaseUrl("postgres://x", { DATABASE_URL: "postgres://y" }),
    ).toBe("postgres://x");
    expect(
      resolveDatabaseUrl(undefined, { DATABASE_URL: "postgres://y" }),
    ).toBe("postgres://y");
    expect(resolveDatabaseUrl(undefined, {})).toBe(localDatabaseUrl({}));
  });
});

describe("schema", () => {
  test("enforces one project per client and project slug", async () => {
    const project = first(
      await db
        .insert(projects)
        .values({ clientSlug: slug, projectSlug: "dup", name: "One" })
        .returning(),
    );
    expect(project.linearTeamId).toBeNull();
    await expect(
      settle(
        db
          .insert(projects)
          .values({ clientSlug: slug, projectSlug: "dup", name: "Two" }),
      ),
    ).rejects.toThrow();
  });

  test("rejects a request whose customer belongs to another project", async () => {
    const { project, customer } = await seedRequest();
    const other = first(
      await db
        .insert(projects)
        .values({
          clientSlug: slug,
          projectSlug: crypto.randomUUID(),
          name: "Other",
        })
        .returning(),
    );
    await expect(
      settle(
        db.insert(requests).values({
          projectId: other.id,
          customerId: customer.id,
          channelKey: `${slug}:cross`,
        }),
      ),
    ).rejects.toThrow();
    const ok = await db
      .insert(requests)
      .values({
        projectId: project.id,
        customerId: customer.id,
        channelKey: `${slug}:same`,
      })
      .returning();
    expect(ok).toHaveLength(1);
  });

  test("enforces one customer per hashed id within a project", async () => {
    const { project } = await seedRequest();
    await expect(
      settle(
        db
          .insert(customers)
          .values({ projectId: project.id, hashedId: "a".repeat(64) }),
      ),
    ).rejects.toThrow();
  });

  test("rejects a message with an unknown origin channel", async () => {
    const { request } = await seedRequest();
    await expect(
      settle(
        db.insert(messages).values({
          requestId: request.id,
          body: "hello",
          originChannel: "fax",
          author: "customer",
          audience: "external",
        }),
      ),
    ).rejects.toThrow();
  });

  test("stores a message with its origin, author, and audience", async () => {
    const { request } = await seedRequest();
    const [message] = await db
      .insert(messages)
      .values({
        requestId: request.id,
        body: "hello",
        originChannel: "widget",
        author: "customer",
        audience: "external",
      })
      .returning();
    expect(message?.bodyFlagged).toBe(false);
    expect(message?.originChannel).toBe("widget");
  });
});

describe("events", () => {
  test("appendEvent stores a validated event with a rising sequence", async () => {
    const first = await appendEvent(db, {
      type: "request.created",
      channelKey: `${slug}:portal`,
      payload: { source: "test" },
    });
    const second = await appendEvent(db, {
      type: "message.created",
      channelKey: `${slug}:portal`,
    });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(first.payload).toEqual({ source: "test" });
    expect(second.requestId).toBeNull();
  });

  test("appendEvent joins a transaction", async () => {
    const { request } = await seedRequest();
    const event = await db.transaction((tx) =>
      appendEvent(tx, {
        type: "request.created",
        channelKey: `${slug}:portal`,
        requestId: request.id,
      }),
    );
    expect(event.requestId).toBe(request.id);
  });

  test("concurrent appends commit in sequence order", async () => {
    const channelKey = `${slug}:order`;
    const readAfter = (cursor: number) =>
      db
        .select()
        .from(events)
        .where(and(eq(events.channelKey, channelKey), gt(events.seq, cursor)))
        .orderBy(events.seq);
    const hold = Promise.withResolvers<void>();
    const aAppended = Promise.withResolvers<number>();
    const txA = db.transaction(async (tx) => {
      const event = await appendEvent(tx, {
        type: "request.created",
        channelKey,
      });
      aAppended.resolve(event.seq);
      await hold.promise;
      return event;
    });
    const seqA = await aAppended.promise;
    let bDone = false;
    const txB = db
      .transaction((tx) =>
        appendEvent(tx, { type: "message.created", channelKey }),
      )
      .finally(() => {
        bDone = true;
      });
    try {
      await Bun.sleep(200);
      expect(bDone).toBe(false);
      const cursorStart = seqA - 1;
      expect(await readAfter(cursorStart)).toHaveLength(0);
      hold.resolve();
      const eventA = await txA;
      const firstPoll = await readAfter(cursorStart);
      const cursor = firstPoll.at(-1)?.seq ?? cursorStart;
      const eventB = await txB;
      const secondPoll = await readAfter(cursor);
      expect(eventA.seq).toBe(seqA);
      expect(eventB.seq).toBeGreaterThan(eventA.seq);
      const seen = [...firstPoll, ...secondPoll].map((row) => row.seq);
      expect(seen).toEqual([eventA.seq, eventB.seq]);
    } finally {
      hold.resolve();
      await Promise.allSettled([txA, txB]);
    }
  });

  test("appendEvent rejects an invalid event", async () => {
    await expect(
      appendEvent(db, { type: "request.created", channelKey: "bad::key" }),
    ).rejects.toThrow();
    await expect(
      appendEvent(db, {
        type: "nope" as never,
        channelKey: "acme",
      }),
    ).rejects.toThrow();
  });

  test("the table rejects UPDATE", async () => {
    const event = await appendEvent(db, {
      type: "ticket.created",
      channelKey: slug,
    });
    await expect(
      settle(
        db
          .update(events)
          .set({ type: "reply.sent" })
          .where(eq(events.id, event.id)),
      ),
    ).rejects.toThrow("append-only");
  });

  test("the table rejects DELETE", async () => {
    const event = await appendEvent(db, {
      type: "ticket.created",
      channelKey: slug,
    });
    await expect(
      settle(db.delete(events).where(eq(events.id, event.id))),
    ).rejects.toThrow("append-only");
  });

  test("the table rejects TRUNCATE", async () => {
    await expect(
      settle(db.execute(dsql`TRUNCATE support.events`)),
    ).rejects.toThrow("append-only");
  });
});

describe("drizzle schema", () => {
  test("declares the expected unique constraints and indexes", () => {
    const names = (table: Parameters<typeof getTableConfig>[0]) => {
      const config = getTableConfig(table);
      return [
        ...config.uniqueConstraints.map((c) => c.getName()),
        ...config.indexes.map((i) => i.config.name),
      ];
    };
    expect(names(projects)).toContain("projects_client_project_uq");
    expect(names(customers)).toContain("customers_project_hashed_uq");
    expect(names(projectKeys)).toContain("project_keys_project_idx");
    expect(names(requests)).toContain("requests_project_created_idx");
    expect(names(messages)).toContain("messages_request_created_idx");
    expect(names(attachments)).toContain("attachments_message_idx");
    expect(names(events)).toContain("events_request_idx");
  });

  test("references the parent tables", () => {
    const fkTargets = [
      projectKeys,
      customers,
      requests,
      messages,
      attachments,
    ].flatMap((table) =>
      getTableConfig(table).foreignKeys.map(
        (fk) => getTableConfig(fk.reference().foreignTable).name,
      ),
    );
    expect(fkTargets).toEqual([
      "projects",
      "projects",
      "projects",
      "customers",
      "customers",
      "requests",
      "messages",
    ]);
  });
});

describe("migrate on an empty database", () => {
  test("applies every file once and creates the support tables", async () => {
    const admin = postgres(resolveDatabaseUrl(), { max: 1 });
    const name = `support_migrate_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    try {
      const url = new URL(resolveDatabaseUrl());
      url.pathname = `/${name}`;
      const applied = await migrate(url.toString());
      expect(applied).toEqual(listMigrations().map((file) => file.name));
      expect(await migrate(url.toString())).toEqual([]);
      const probe = postgres(url.toString(), { max: 1 });
      const tables = await probe<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'support' ORDER BY table_name`;
      const pipeline = await probe<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'task_run'`;
      await probe.end();
      expect(pipeline).toHaveLength(1);
      expect(tables.map((t) => t.table_name)).toEqual([
        "attachment_rejections",
        "attachments",
        "channel_delays",
        "comment_changes",
        "customers",
        "event_cursors",
        "events",
        "inbound_comments",
        "integrations",
        "judgments",
        "message_deliveries",
        "messages",
        "project_keys",
        "projects",
        "rate_limits",
        "replies",
        "requests",
        "schema_migrations",
        "subscriptions",
        "ticket_deliveries",
        "tickets",
        "triage_jobs",
        "watcher_credentials",
        "webhook_deliveries",
      ]);
    } finally {
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
