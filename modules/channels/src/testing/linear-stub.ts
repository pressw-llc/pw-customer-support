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
    failNext(count, message = "Internal server error") {
      failures = { count, message };
    },
    reset() {
      stub.calls.length = 0;
      stub.issues.length = 0;
      stub.labels.length = 0;
      stub.comments.length = 0;
      counters.clear();
    },
    stop: async () => {
      await server.stop(true);
    },
  };
  let failures = { count: 0, message: "" };
  const counters = new Map<string, number>();

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
      const comment = {
        id: crypto.randomUUID(),
        issueId: issue.id,
        body: input.body,
      };
      stub.comments.push(comment);
      return { commentCreate: { success: true, comment: { id: comment.id } } };
    },
  };

  const server = Bun.serve({
    port: options.port ?? 0,
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
  stub.url = `http://127.0.0.1:${stub.port}/graphql`;
  return stub;
}
