import { z } from "zod";

export const LINEAR_API_URL = "https://api.linear.app/graphql";
export const LINEAR_KEY_SECRET = "linear-api-key";

export interface SecretsProvider {
  get(name: string): Promise<string>;
}

export function envSecrets(
  env: Record<string, string | undefined> = process.env,
): SecretsProvider {
  const names: Record<string, string> = {
    [LINEAR_KEY_SECRET]: "LINEAR_API_KEY",
  };
  return {
    async get(name) {
      const variable = names[name];
      const value = variable ? env[variable] : undefined;
      if (!value) throw new Error(`secret ${name} is not configured`);
      return value;
    },
  };
}

export class LinearError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LinearError";
  }
}

export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  description: string;
  priority: number;
  labelIds: string[];
}

export interface LinearClient {
  getTeam(
    teamId: string,
  ): Promise<{ id: string; key: string; name: string } | null>;
  findOrCreateLabel(teamId: string, name: string): Promise<string>;
  findIssueByMarker(
    teamId: string,
    marker: string,
  ): Promise<LinearIssue | null>;
  createIssue(input: CreateIssueInput): Promise<LinearIssue>;
  createComment(issueId: string, body: string): Promise<{ id: string }>;
  archiveIssue(issueId: string): Promise<boolean>;
}

export interface LinearClientOptions {
  secrets: SecretsProvider;
  apiUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const envelope = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const issueShape = z.object({
  id: z.string(),
  identifier: z.string(),
  url: z.string(),
});

function lastLine(description: string): string {
  return description.trimEnd().split(/\r?\n/).pop() ?? "";
}

const labelNode = z.object({ id: z.string(), name: z.string() });

export function createLinearClient(options: LinearClientOptions): LinearClient {
  const fetcher = options.fetcher ?? fetch;
  const apiUrl = options.apiUrl ?? LINEAR_API_URL;
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function request<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const key = await options.secrets.get(LINEAR_KEY_SECRET);
    const response = await fetcher(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: z.infer<typeof envelope>;
    try {
      body = envelope.parse(JSON.parse(text));
    } catch {
      throw new LinearError(
        `Linear answered ${response.status} with an unreadable body`,
        response.status,
      );
    }
    if (body.errors?.length) {
      throw new LinearError(
        `Linear error: ${body.errors.map((e) => e.message).join("; ")}`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new LinearError(
        `Linear answered ${response.status}`,
        response.status,
      );
    }
    return schema.parse(body.data);
  }

  return {
    async getTeam(teamId) {
      const data = await request(
        "query Team($id: String!) { team(id: $id) { id key name } }",
        { id: teamId },
        z.object({
          team: z
            .object({ id: z.string(), key: z.string(), name: z.string() })
            .nullable(),
        }),
      );
      return data.team;
    },

    async findOrCreateLabel(teamId, name) {
      const found = await request(
        "query Labels($teamId: ID!, $name: String!) { issueLabels(first: 1, filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) { nodes { id name } } }",
        { teamId, name },
        z.object({ issueLabels: z.object({ nodes: z.array(labelNode) }) }),
      );
      const existing = found.issueLabels.nodes[0];
      if (existing) return existing.id;
      const created = await request(
        "mutation LabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }",
        { input: { teamId, name } },
        z.object({
          issueLabelCreate: z.object({
            success: z.boolean(),
            issueLabel: labelNode.nullable(),
          }),
        }),
      );
      const label = created.issueLabelCreate.issueLabel;
      if (!created.issueLabelCreate.success || !label) {
        throw new LinearError(`Linear did not create label ${name}`);
      }
      return label.id;
    },

    async findIssueByMarker(teamId, marker) {
      const data = await request(
        "query Issues($teamId: ID!, $marker: String!) { issues(first: 20, filter: { team: { id: { eq: $teamId } }, description: { endsWith: $marker } }) { nodes { id identifier url description } } }",
        { teamId, marker },
        z.object({
          issues: z.object({
            nodes: z.array(
              issueShape.extend({ description: z.string().nullable() }),
            ),
          }),
        }),
      );
      const match = data.issues.nodes.find(
        (node) => lastLine(node.description ?? "") === marker,
      );
      return match
        ? { id: match.id, identifier: match.identifier, url: match.url }
        : null;
    },

    async createIssue(input) {
      const data = await request(
        "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
        { input },
        z.object({
          issueCreate: z.object({
            success: z.boolean(),
            issue: issueShape.nullable(),
          }),
        }),
      );
      const issue = data.issueCreate.issue;
      if (!data.issueCreate.success || !issue) {
        throw new LinearError("Linear did not create the issue");
      }
      return issue;
    },

    async createComment(issueId, body) {
      const data = await request(
        "mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
        { input: { issueId, body } },
        z.object({
          commentCreate: z.object({
            success: z.boolean(),
            comment: z.object({ id: z.string() }).nullable(),
          }),
        }),
      );
      const comment = data.commentCreate.comment;
      if (!data.commentCreate.success || !comment) {
        throw new LinearError("Linear did not create the comment");
      }
      return comment;
    },

    async archiveIssue(issueId) {
      const data = await request(
        "mutation IssueArchive($id: String!) { issueArchive(id: $id) { success } }",
        { id: issueId },
        z.object({ issueArchive: z.object({ success: z.boolean() }) }),
      );
      return data.issueArchive.success;
    },
  };
}
