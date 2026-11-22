import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  handleViewerRequest,
  renderViewer,
  type ViewerStub,
} from "./viewer";

function fakeStub(): ViewerStub & {
  posted: { issueId: string; body: string }[];
} {
  const posted: { issueId: string; body: string }[] = [];
  return {
    posted,
    issues: [
      {
        id: "i1",
        identifier: "ACME-1",
        url: "http://stub/ACME-1",
        title: "Export <fails>",
        description: "Customer says: <script>alert(1)</script>",
        priority: 2,
        labelIds: ["l1", "l-unknown"],
      },
    ],
    comments: [
      {
        id: "c1",
        issueId: "i1",
        body: "@external hello & welcome",
        userName: "Ada",
      },
      { id: "c2", issueId: "other", body: "elsewhere", userName: "Bob" },
    ],
    labels: [{ id: "l1", name: "bug" }],
    async staffComment(input) {
      posted.push(input);
      return {};
    },
  };
}

describe("renderViewer", () => {
  test("escapes every customer controlled field", () => {
    const html = renderViewer(fakeStub());
    expect(html).toContain("Export &lt;fails&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("@external hello &amp; welcome");
    expect(html).not.toContain("elsewhere");
  });

  test("names labels and falls back to the id", () => {
    const html = renderViewer(fakeStub());
    expect(html).toContain('<span class="label">bug</span>');
    expect(html).toContain('<span class="label">l-unknown</span>');
  });

  test("shows an empty state", () => {
    const html = renderViewer({ ...fakeStub(), issues: [] });
    expect(html).toContain("No tickets yet.");
    expect(escapeHtml('"&<>')).toBe("&quot;&amp;&lt;&gt;");
  });

  test("shows none for an issue with no comments", () => {
    const stub = fakeStub();
    stub.comments = [];
    expect(renderViewer(stub)).toContain("<li>none</li>");
  });
});

describe("handleViewerRequest", () => {
  const call = (stub: ViewerStub, path: string, init?: RequestInit) =>
    handleViewerRequest(stub, new Request(`http://viewer${path}`, init));

  test("serves the page, the health check, and the JSON state", async () => {
    const stub = fakeStub();
    const page = await call(stub, "/");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect((await call(stub, "/health")).status).toBe(200);
    const json = (await (await call(stub, "/api/issues")).json()) as {
      issues: unknown[];
    };
    expect(json.issues).toHaveLength(1);
  });

  test("posts a staff comment by ticket identifier", async () => {
    const stub = fakeStub();
    const response = await call(stub, "/api/comment", {
      method: "POST",
      body: JSON.stringify({
        identifier: "ACME-1",
        body: "@external We fixed it.",
      }),
    });
    expect(response.status).toBe(200);
    expect(stub.posted).toEqual([
      { issueId: "i1", body: "@external We fixed it." },
    ]);
  });

  test("rejects an unknown ticket, an empty body, bad JSON, and unknown routes", async () => {
    const stub = fakeStub();
    for (const body of [
      JSON.stringify({ identifier: "NOPE-1", body: "x" }),
      JSON.stringify({ identifier: "ACME-1", body: "" }),
      "not json",
    ]) {
      expect(
        (await call(stub, "/api/comment", { method: "POST", body })).status,
      ).toBe(400);
    }
    expect((await call(stub, "/missing")).status).toBe(404);
    expect(stub.posted).toEqual([]);
  });
});
