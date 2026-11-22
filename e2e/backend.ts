import { createAdapterRuntime } from "@pw-support/channels";
import { STUB_HOST, startLinearStub } from "@pw-support/channels/testing";
import {
  advanceEventCursor,
  createDb,
  ensureProject,
  maxEventSeq,
  migrate,
  setProjectLinearTeam,
} from "@pw-support/db";

process.env.TYPESAFE_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const apiPort = Number(process.env.E2E_API_PORT);
const stubPort = Number(process.env.E2E_STUB_PORT);
const controlPort = Number(process.env.E2E_CONTROL_PORT);
const secret = process.env.LINEAR_WEBHOOK_SECRET as string;
const clientSlug = process.env.SEED_CLIENT_SLUG as string;
const projectSlug = process.env.SEED_PROJECT_SLUG as string;

const wordingCalls: string[] = [];
const scorer = {
  async score(text: string) {
    wordingCalls.push(text);
    if (text.includes("[JEVDOWN]")) throw new Error("jev unavailable");
    const score = text.includes("[RUDE]")
      ? 1
      : text.includes("[BORDER]")
        ? 2.5
        : 4;
    return { score, raw: { e2e: true, score } };
  },
};

const stub = startLinearStub({ port: stubPort });
stub.configureWebhook({
  url: `http://127.0.0.1:${apiPort}/webhooks/linear`,
  secret,
});

await migrate();
const db = createDb();
await ensureProject(db, {
  clientSlug,
  projectSlug,
  name: `${clientSlug} ${projectSlug}`,
  key: process.env.SEED_PROJECT_KEY,
});
await setProjectLinearTeam(db, {
  clientSlug,
  projectSlug,
  linearTeamId: stub.teams[0]?.id ?? null,
});
await advanceEventCursor(db, "linear", await maxEventSeq(db));

Bun.serve({
  port: controlPort,
  hostname: STUB_HOST,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/issues") return Response.json(stub.issues);
    if (url.pathname === "/comments") {
      return Response.json(
        stub.comments.filter(
          (comment) => comment.issueId === url.searchParams.get("issueId"),
        ),
      );
    }
    if (url.pathname === "/wording-calls") return Response.json(wordingCalls);
    if (url.pathname === "/staff-comment" && request.method === "POST") {
      const input = await request.json();
      const result = await stub.staffComment(input);
      return Response.json({
        comment: result.comment,
        delivery: result.delivery,
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const { main } = await import(
  "../pipelines/support-triage/fargate-entries/main"
);
const channels = createAdapterRuntime(
  {
    ...process.env,
    LINEAR_API_URL: stub.url,
    LINEAR_API_KEY: "lin_api_e2e",
  },
  { wording: scorer },
);
console.log(`[e2e-backend] stub ${stub.url}, control ${controlPort}`);
await main({ channels });
process.exit(0);
