export interface ViewerIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string;
  priority: number;
  labelIds: string[];
}

export interface ViewerComment {
  id: string;
  issueId: string;
  body: string;
  userName: string;
}

export interface ViewerStub {
  issues: ViewerIssue[];
  comments: ViewerComment[];
  labels: { id: string; name: string }[];
  staffComment(input: { issueId: string; body: string }): Promise<unknown>;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderViewer(stub: ViewerStub): string {
  const labelName = (id: string) =>
    stub.labels.find((label) => label.id === id)?.name ?? id;
  const issues = stub.issues
    .map((issue) => {
      const comments = stub.comments
        .filter((comment) => comment.issueId === issue.id)
        .map(
          (comment) =>
            `<li><strong>${escapeHtml(comment.userName)}</strong><pre>${escapeHtml(comment.body)}</pre></li>`,
        )
        .join("");
      const labels = issue.labelIds
        .map((id) => `<span class="label">${escapeHtml(labelName(id))}</span>`)
        .join(" ");
      return `<section><h2>${escapeHtml(issue.identifier)} ${escapeHtml(issue.title)}</h2>
<p>priority ${issue.priority} ${labels}</p>
<pre>${escapeHtml(issue.description)}</pre>
<h3>Comments</h3><ul>${comments || "<li>none</li>"}</ul></section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>Linear stub</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:760px}pre{white-space:pre-wrap;background:#f4f4f5;padding:.75rem;border-radius:6px}.label{background:#e0e7ff;border-radius:4px;padding:0 .4rem}section{border-top:1px solid #ddd;margin-top:1.5rem}</style>
</head><body><h1>Linear stub</h1><p>${stub.issues.length} issue(s). This page refreshes every 3 seconds.</p>
${issues || "<p>No tickets yet.</p>"}</body></html>`;
}

export async function handleViewerRequest(
  stub: ViewerStub,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    return new Response(renderViewer(stub), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }
  if (request.method === "GET" && url.pathname === "/api/issues") {
    return Response.json({
      issues: stub.issues,
      comments: stub.comments,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/comment") {
    const body = (await request.json().catch(() => null)) as {
      identifier?: string;
      body?: string;
    } | null;
    const issue = stub.issues.find(
      (candidate) => candidate.identifier === body?.identifier,
    );
    if (!issue || typeof body?.body !== "string" || body.body === "") {
      return Response.json(
        { error: "identifier and body are required" },
        { status: 400 },
      );
    }
    await stub.staffComment({ issueId: issue.id, body: body.body });
    return Response.json({ posted: true, identifier: issue.identifier });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}
