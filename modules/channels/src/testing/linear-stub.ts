import { signLinearWebhook } from "./sign";

export interface StubTeam {
  id: string;
  key: string;
  name: string;
}

export interface StubLabel {
  id: string;
  name: string;
  teamId: string;
}

export interface StubIssue {
  id: string;
  identifier: string;
  url: string;
  teamId: string;
  title: string;
  description: string;
  priority: number;
  labelIds: string[];
  archived: boolean;
}

export interface StubComment {
  id: string;
  issueId: string;
  body: string;
  userId: string | null;
  userName: string;
  parentId: string | null;
  createdAt?: string;
  updatedAt?: string;
  payloadExtra?: PayloadExtra;
}

export interface PayloadExtra {
  data?: Record<string, unknown>;
  actor?: Record<string, unknown>;
}

export interface StubWebhookTarget {
  url: string;
  secret: string;
}

export interface StubDelivery {
  deliveryId: string;
  commentId: string;
  status: number;
  body: string;
}

export interface StaffCommentInput {
  issueId: string;
  body: string;
  userId?: string | null;
  userName?: string;
  parentId?: string;
  createdAt?: Date;
  deliver?: boolean;
  payloadExtra?: PayloadExtra;
}

export type CommentAction = "create" | "update" | "remove";

export interface WebhookOverrides {
  deliveryId?: string;
  timestamp?: number;
  secret?: string;
  signature?: string | null;
  omitDelivery?: boolean;
  rawBody?: string;
  action?: CommentAction;
}

export const STUB_VIEWER_ID = "user-integration";
export const STUB_VIEWER_NAME = "PressW Support Integration";
export const STUB_STAFF_ID = "user-staff-ada";
export const STUB_STAFF_NAME = "Ada Staff";
export const STUB_HOST = "127.0.0.1";

export function commentWebhookPayload(
  comment: StubComment,
  timestamp: number = Date.now(),
  action: CommentAction = "create",
): Record<string, unknown> {
  const createdAt = comment.createdAt ?? new Date(timestamp).toISOString();
  const human = comment.userId !== null;
  return {
    action,
    type: "Comment",
    actor: {
      ...(human ? { id: comment.userId, name: comment.userName } : {}),
      type: "user",
      ...comment.payloadExtra?.actor,
    },
    createdAt,
    data: {
      id: comment.id,
      createdAt,
      updatedAt: comment.updatedAt ?? new Date(timestamp).toISOString(),
      body: comment.body,
      issueId: comment.issueId,
      parentId: comment.parentId,
      userId: comment.userId,
      user: human ? { id: comment.userId, name: comment.userName } : null,
      ...comment.payloadExtra?.data,
    },
    url: `https://linear.app/stub/issue/${comment.issueId}#comment-${comment.id}`,
    organizationId: "org-stub",
    webhookTimestamp: timestamp,
    webhookId: "webhook-stub",
  };
}

export const freshConnectionFetch = ((
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => fetch(url, { ...init, keepalive: false })) as typeof fetch;

export async function deliverCommentWebhook(
  target: StubWebhookTarget,
  comment: StubComment,
  overrides: WebhookOverrides = {},
): Promise<StubDelivery> {
  const deliveryId = overrides.deliveryId ?? crypto.randomUUID();
  const rawBody =
    overrides.rawBody ??
    JSON.stringify(
      commentWebhookPayload(comment, overrides.timestamp, overrides.action),
    );
  const signature =
    overrides.signature === undefined
      ? signLinearWebhook(overrides.secret ?? target.secret, rawBody)
      : overrides.signature;
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Linear-Event": "Comment",
    "User-Agent": "Linear-Webhook",
  };
  if (signature !== null) headers["Linear-Signature"] = signature;
  if (!overrides.omitDelivery) headers["Linear-Delivery"] = deliveryId;
  const response = await fetch(target.url, {
    method: "POST",
    headers,
    body: rawBody,
    keepalive: false,
  });
  return {
    deliveryId,
    commentId: comment.id,
    status: response.status,
    body: await response.text(),
  };
}

export interface StubCall {
  operation: string;
  variables: Record<string, unknown>;
  authorization: string | null;
}

export interface LinearStub {
  url: string;
  port: number;
  calls: StubCall[];
  issues: StubIssue[];
  labels: StubLabel[];
  comments: StubComment[];
  teams: StubTeam[];
  deliveries: StubDelivery[];
  viewerId: string;
  configureWebhook(target: StubWebhookTarget | null): void;
  staffComment(input: StaffCommentInput): Promise<{
    comment: StubComment;
    delivery: StubDelivery | null;
  }>;
  editComment(commentId: string, body: string): Promise<StubDelivery | null>;
  removeComment(commentId: string): Promise<StubDelivery | null>;
  failNext(count: number, message?: string): void;
  reset(): void;
  stop(): Promise<void>;
}

export interface StubOptions {
  port?: number;
  teams?: StubTeam[];
}

export const DEFAULT_STUB_TEAMS: StubTeam[] = [
  { id: "team-acme-support", key: "ACME", name: "Acme Support" },
];

const OPERATIONS: [string, RegExp][] = [
  ["viewer", /\bviewer\s*\{/],
  ["comment", /\bcomment\s*\(\s*id/],
  ["issueComments", /\bissue\s*\(\s*id/],
  ["issueLabelCreate", /\bissueLabelCreate\s*\(/],
  ["issueLabels", /\bissueLabels\s*\(/],
  ["issueCreate", /\bissueCreate\s*\(/],
  ["issueArchive", /\bissueArchive\s*\(/],
  ["commentCreate", /\bcommentCreate\s*\(/],
  ["issues", /\bissues\s*\(/],
  ["team", /\bteam\s*\(/],
];

class GraphQlFailure extends Error {
  constructor(
    message: string,
    readonly status = 200,
  ) {
    super(message);
  }
}

function nextUpdatedAt(previous: string | undefined): string {
  const floor = previous ? new Date(previous).getTime() + 1 : 0;
  return new Date(Math.max(Date.now(), floor)).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function nested(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((current, key) => asRecord(current)[key], value);
}

export function startLinearStub(options: StubOptions = {}): LinearStub {
  const teams = options.teams ?? DEFAULT_STUB_TEAMS;
  const stub: LinearStub = {
    url: "",
    port: 0,
    calls: [],
    issues: [],
    labels: [],
    comments: [],
    teams,
    deliveries: [],
    viewerId: STUB_VIEWER_ID,
    configureWebhook(target) {
      webhook = target;
    },
    async staffComment(input) {
      const issue = stub.issues.find((i) => i.id === input.issueId);
      if (!issue) throw new GraphQlFailure("Entity not found: Issue");
      const comment: StubComment = {
        id: crypto.randomUUID(),
        issueId: issue.id,
        body: input.body,
        userId: input.userId === undefined ? STUB_STAFF_ID : input.userId,
        userName: input.userName ?? STUB_STAFF_NAME,
        parentId: input.parentId ?? null,
        createdAt: (input.createdAt ?? new Date()).toISOString(),
        updatedAt: (input.createdAt ?? new Date()).toISOString(),
        payloadExtra: input.payloadExtra,
      };
      stub.comments.push(comment);
      return {
        comment,
        delivery: input.deliver === false ? null : await emit(comment),
      };
    },
    async editComment(commentId, body) {
      const comment = stub.comments.find((c) => c.id === commentId);
      if (!comment) throw new GraphQlFailure("Entity not found: Comment");
      comment.body = body;
      comment.updatedAt = nextUpdatedAt(comment.updatedAt);
      return emit(comment, "update");
    },
    async removeComment(commentId) {
      const index = stub.comments.findIndex((c) => c.id === commentId);
      const comment = stub.comments[index];
      if (!comment) throw new GraphQlFailure("Entity not found: Comment");
      stub.comments.splice(index, 1);
      return emit(comment, "remove");
    },
    failNext(count, message = "Internal server error") {
      failures = { count, message };
    },
    reset() {
      stub.calls.length = 0;
      stub.issues.length = 0;
      stub.labels.length = 0;
      stub.comments.length = 0;
      stub.deliveries.length = 0;
      counters.clear();
    },
    stop: async () => {
      await Promise.allSettled([...pending]);
      await server.stop(true);
    },
  };
  let failures = { count: 0, message: "" };
  let webhook: StubWebhookTarget | null = null;
  const counters = new Map<string, number>();
  const pending = new Set<Promise<unknown>>();

  function emitInBackground(comment: StubComment): void {
    const delivery = emit(comment).finally(() => pending.delete(delivery));
    pending.add(delivery);
  }

  async function emit(
    comment: StubComment,
    action: CommentAction = "create",
  ): Promise<StubDelivery | null> {
    if (!webhook) return null;
    try {
      const delivery = await deliverCommentWebhook(webhook, comment, {
        action,
      });
      stub.deliveries.push(delivery);
      return delivery;
    } catch {
      return null;
    }
  }

  function team(id: unknown): StubTeam {
    const found = teams.find((t) => t.id === id || t.key === id);
    if (!found) throw new GraphQlFailure("Entity not found: Team");
    return found;
  }

  function nextIdentifier(t: StubTeam): string {
    const next = (counters.get(t.id) ?? 0) + 1;
    counters.set(t.id, next);
    return `${t.key}-${next}`;
  }

  const handlers: Record<
    string,
    (vars: Record<string, unknown>, query: string) => unknown
  > = {
    team(vars) {
      const found = teams.find((t) => t.id === vars.id || t.key === vars.id);
      return { team: found ?? null };
    },
    issueLabels(vars) {
      const teamId = nested(vars, "teamId");
      const name = vars.name;
      const nodes = stub.labels
        .filter((l) => l.teamId === teamId && l.name === name)
        .slice(0, 1)
        .map((l) => ({ id: l.id, name: l.name }));
      return { issueLabels: { nodes } };
    },
    issueLabelCreate(vars) {
      const input = asRecord(vars.input);
      const owner = team(input.teamId);
      const name = input.name;
      if (typeof name !== "string" || name.trim() === "") {
        throw new GraphQlFailure(
          "Argument Validation Error: name must not be empty",
        );
      }
      if (stub.labels.some((l) => l.teamId === owner.id && l.name === name)) {
        throw new GraphQlFailure(`Duplicate label name: ${name}`);
      }
      const label = { id: crypto.randomUUID(), name, teamId: owner.id };
      stub.labels.push(label);
      return {
        issueLabelCreate: {
          success: true,
          issueLabel: { id: label.id, name: label.name },
        },
      };
    },
    issues(vars, query) {
      const teamId = vars.teamId;
      const marker = String(vars.marker ?? "");
      const operator = /description:\s*\{\s*(\w+)\s*:/.exec(query)?.[1];
      const first = Number(/first:\s*(\d+)/.exec(query)?.[1] ?? 50);
      const matches = (description: string) =>
        operator === "endsWith"
          ? description.endsWith(marker)
          : description.includes(marker);
      const nodes = stub.issues
        .filter(
          (i) =>
            i.teamId === teamId &&
            !i.archived &&
            marker !== "" &&
            matches(i.description),
        )
        .slice(0, first)
        .map(({ id, identifier, url, description }) => ({
          id,
          identifier,
          url,
          description,
        }));
      return { issues: { nodes } };
    },
    issueCreate(vars) {
      const input = asRecord(vars.input);
      const owner = team(input.teamId);
      const title = input.title;
      if (typeof title !== "string" || title.trim() === "") {
        throw new GraphQlFailure(
          "Argument Validation Error: title must not be empty",
        );
      }
      const priority = input.priority ?? 0;
      if (
        !Number.isInteger(priority) ||
        (priority as number) < 0 ||
        (priority as number) > 4
      ) {
        throw new GraphQlFailure(
          "Argument Validation Error: priority must be 0 to 4",
        );
      }
      const labelIds = Array.isArray(input.labelIds)
        ? (input.labelIds as string[])
        : [];
      for (const labelId of labelIds) {
        if (
          !stub.labels.some((l) => l.id === labelId && l.teamId === owner.id)
        ) {
          throw new GraphQlFailure(`Entity not found: IssueLabel ${labelId}`);
        }
      }
      const identifier = nextIdentifier(owner);
      const issue: StubIssue = {
        id: crypto.randomUUID(),
        identifier,
        url: `https://linear.app/stub/issue/${identifier}`,
        teamId: owner.id,
        title,
        description:
          typeof input.description === "string" ? input.description : "",
        priority: priority as number,
        labelIds,
        archived: false,
      };
      stub.issues.push(issue);
      return {
        issueCreate: {
          success: true,
          issue: { id: issue.id, identifier, url: issue.url },
        },
      };
    },
    issueArchive(vars) {
      const issue = stub.issues.find((i) => i.id === vars.id);
      if (!issue) throw new GraphQlFailure("Entity not found: Issue");
      issue.archived = true;
      return { issueArchive: { success: true } };
    },
    commentCreate(vars) {
      const input = asRecord(vars.input);
      const issue = stub.issues.find((i) => i.id === input.issueId);
      if (!issue) throw new GraphQlFailure("Entity not found: Issue");
      if (typeof input.body !== "string" || input.body === "") {
        throw new GraphQlFailure(
          "Argument Validation Error: body must not be empty",
        );
      }
      const parentId =
        typeof input.parentId === "string" ? input.parentId : null;
      if (
        parentId !== null &&
        !stub.comments.some((c) => c.id === parentId && c.issueId === issue.id)
      ) {
        throw new GraphQlFailure("Entity not found: Comment");
      }
      const comment: StubComment = {
        id: crypto.randomUUID(),
        issueId: issue.id,
        body: input.body,
        userId: stub.viewerId,
        userName: STUB_VIEWER_NAME,
        parentId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      stub.comments.push(comment);
      emitInBackground(comment);
      return { commentCreate: { success: true, comment: { id: comment.id } } };
    },
    viewer() {
      return { viewer: { id: stub.viewerId } };
    },
    comment(vars) {
      const found = stub.comments.find((c) => c.id === vars.id);
      if (!found) throw new GraphQlFailure("Entity not found: Comment");
      const extra = found.payloadExtra?.data ?? {};
      return {
        comment: {
          id: found.id,
          body: found.body,
          createdAt: found.createdAt ?? new Date().toISOString(),
          updatedAt: found.updatedAt ?? new Date().toISOString(),
          archivedAt: null,
          issue: { id: found.issueId },
          parent: found.parentId ? { id: found.parentId } : null,
          user:
            found.userId === null
              ? null
              : { id: found.userId, name: found.userName, app: false },
          botActor: extra.botActor ?? null,
          externalUser: extra.externalUser ?? null,
        },
      };
    },
    issueComments(vars, query) {
      const issue = stub.issues.find((i) => i.id === vars.issueId);
      if (!issue) return { issue: null };
      const marker = String(vars.marker ?? "");
      const operator = /body:\s*\{\s*(\w+)\s*:/.exec(query)?.[1];
      const nodes = stub.comments
        .filter(
          (c) =>
            c.issueId === issue.id &&
            marker !== "" &&
            (operator === "endsWith"
              ? c.body.endsWith(marker)
              : c.body.includes(marker)),
        )
        .map(({ id, body }) => ({ id, body }));
      return { issue: { comments: { nodes } } };
    },
  };

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: STUB_HOST,
    idleTimeout: 0,
    async fetch(request) {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const authorization = request.headers.get("authorization");
      if (!authorization) {
        return Response.json(
          { errors: [{ message: "Authentication required" }] },
          { status: 400 },
        );
      }
      if (/^bearer\s/i.test(authorization)) {
        return Response.json(
          {
            errors: [
              { message: "Personal API keys do not use the Bearer prefix" },
            ],
          },
          { status: 401 },
        );
      }
      const body = asRecord(await request.json().catch(() => null));
      const query = typeof body.query === "string" ? body.query : "";
      const variables = asRecord(body.variables);
      const operation =
        OPERATIONS.find(([, pattern]) => pattern.test(query))?.[0] ?? "unknown";
      stub.calls.push({ operation, variables, authorization });
      if (failures.count > 0) {
        failures = { ...failures, count: failures.count - 1 };
        return Response.json(
          { errors: [{ message: failures.message }] },
          { status: 500 },
        );
      }
      const handler = handlers[operation];
      if (!handler) {
        return Response.json(
          { errors: [{ message: "Cannot query unknown field" }] },
          { status: 400 },
        );
      }
      try {
        return Response.json({ data: handler(variables, query) });
      } catch (error) {
        if (error instanceof GraphQlFailure) {
          return Response.json(
            { errors: [{ message: error.message }], data: null },
            { status: error.status },
          );
        }
        throw error;
      }
    },
  });
  stub.port = server.port ?? 0;
  stub.url = `http://${STUB_HOST}:${stub.port}/graphql`;
  return stub;
}
