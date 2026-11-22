import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { dumpDatabase } from "@pw-support/api/testing";
import { createSecretsManagerClient } from "@pw-support/channels";
import {
  LOCAL_OIDC_CLIENT_ID,
  resolveStackEnv,
  secretId,
} from "@pw-support/contracts";
import {
  closeDb,
  createDb,
  events,
  getAdminProject,
  inboundComments,
  integrations,
  messages,
  migrate,
  persistInboundRequest,
  projects,
  replies,
  upsertCustomer,
} from "@pw-support/db";
import { eq } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import { freePort } from "./free-port";

const stack = resolveStackEnv(process.env);
const port = Number(process.env.VALIDATE_API_PORT) || freePort();
const apiUrl = `http://127.0.0.1:${port}`;
const issuer = stack.localIssuer;
const scope = `validate-${Date.now().toString(36)}`;
const secret = `lin_api_${crypto.randomUUID().replaceAll("-", "")}`;
const slug = `v${Date.now().toString(36)}`;

let failed = false;
function report(ok: boolean, name: string, detail = ""): void {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

let logs = "";
function spawnApi(apiPort: number, extra: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", "apps/server/src/server.ts"], {
    env: {
      ...process.env,
      API_PORT: String(apiPort),
      SECRETS_SCOPE: scope,
      COGNITO_ISSUER: issuer,
      COGNITO_AUDIENCE: LOCAL_OIDC_CLIENT_ID,
      ...extra,
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const stream of [child.stdout, child.stderr]) {
    void (async () => {
      for await (const chunk of stream) logs += Buffer.from(chunk).toString();
    })();
  }
  return child;
}
const policyPort = Number(process.env.VALIDATE_API_PORT)
  ? port + 1
  : freePort();
const api = spawnApi(port);
const policyApi = spawnApi(policyPort, { ADMIN_REQUIRED_GROUP: "desk-staff" });

async function waitForApi(): Promise<void> {
  for (const base of [apiUrl, `http://127.0.0.1:${policyPort}`]) {
    await waitForHealth(base);
  }
}

async function waitForHealth(base: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("the API did not become healthy");
}

async function issuedToken(): Promise<string> {
  const response = await fetch(`${issuer}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: LOCAL_OIDC_CLIENT_ID,
      client_secret: "validate",
      scope: LOCAL_OIDC_CLIENT_ID,
    }),
  });
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const db = createDb();
const sm = createSecretsManagerClient(process.env);

try {
  await migrate();
  await waitForApi();

  const real = await issuedToken();
  const alien = await generateKeyPair("RS256");
  const forged = await new SignJWT({
    sub: "attacker",
    aud: LOCAL_OIDC_CLIENT_ID,
  })
    .setProtectedHeader({ alg: "RS256", kid: "support" })
    .setIssuer(issuer)
    .setExpirationTime("5m")
    .sign(alien.privateKey);
  const otherIssuer = await new SignJWT({
    sub: "attacker",
    aud: LOCAL_OIDC_CLIENT_ID,
  })
    .setProtectedHeader({ alg: "RS256", kid: "support" })
    .setIssuer("https://other-issuer.example/pool")
    .setExpirationTime("5m")
    .sign(alien.privateKey);

  const anonymous = await call("GET", "/admin/requests");
  report(
    anonymous.status === 401,
    "A19 401 without a token",
    `status ${anonymous.status}`,
  );
  const withForged = await call("GET", "/admin/requests", forged);
  report(
    withForged.status === 401,
    "A19 401 with a token signed by another key",
    `status ${withForged.status}`,
  );
  const withOther = await call("GET", "/admin/requests", otherIssuer);
  report(
    withOther.status === 401,
    "A19 401 with a token from another issuer",
    `status ${withOther.status}`,
  );
  const withReal = await call("GET", "/admin/requests", real);
  report(
    withReal.status === 200,
    "A19 200 with a token from the local issuer",
    `status ${withReal.status}`,
  );

  const policyCall = async (token: string) =>
    fetch(`http://127.0.0.1:${policyPort}/admin/requests`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  const outsideGroup = await policyCall(real);
  report(
    outsideGroup.status === 403 &&
      outsideGroup.headers.get("WWW-Authenticate") === null &&
      JSON.stringify(await outsideGroup.json()) === '{"error":"forbidden"}',
    "A19 403 forbidden for a valid token missing the required group",
    `status ${outsideGroup.status}`,
  );
  const forgedOnPolicy = await policyCall(forged);
  report(
    forgedOnPolicy.status === 401,
    "A19 401 for a forged token on the group-restricted API",
    `status ${forgedOnPolicy.status}`,
  );

  const created = await call("POST", "/admin/projects", real, {
    clientSlug: "acme",
    projectSlug: slug,
    name: "Validation project",
  });
  const project = JSON.parse(created.text) as { id: string };
  const emails = ["lead@acme.test", "oncall@acme.test"];
  await call("PUT", `/admin/projects/${project.id}/cc-list`, real, { emails });
  const reread = JSON.parse(
    (await call("GET", "/admin/projects", real)).text,
  ) as {
    id: string;
    ccList: string[];
  }[];
  const stored = reread.find((row) => row.id === project.id)?.ccList ?? [];
  report(
    JSON.stringify(stored) === JSON.stringify(emails),
    "A29 the saved CC list is returned on the next read",
    stored.join(","),
  );

  const seeded = await getAdminProject(db, project.id);
  if (!seeded) throw new Error("the validation project is missing");
  const customer = await upsertCustomer(db, project.id, "f".repeat(64));
  const request = await persistInboundRequest(db, {
    scope: { project: seeded.project, customer },
    body: "Validation request with a flagged reply",
  });
  const [sentMessage] = await db
    .insert(messages)
    .values({
      requestId: request.request.id,
      body: "Thanks for waiting",
      originChannel: "linear",
      author: "staff",
      authorName: "Ada Staff",
      audience: "external",
    })
    .returning();
  const [inbound] = await db
    .insert(inboundComments)
    .values({
      commentId: `validate-${slug}`,
      issueId: `issue-${slug}`,
      body: "@external Thanks for waiting",
      requestId: request.request.id,
      status: "processed",
    })
    .returning();
  await db.insert(replies).values({
    requestId: request.request.id,
    inboundCommentId: (inbound as NonNullable<typeof inbound>).id,
    threadRootId: `validate-${slug}`,
    authorName: "Ada Staff",
    body: "Thanks for waiting",
    status: "sent",
    wordingScore: 2.5,
    flagged: true,
    messageId: sentMessage?.id,
    sentAt: new Date(),
  });
  const flaggedPath = `/admin/requests?projectId=${project.id}&flaggedReplies=true`;
  const flaggedAnonymous = await call("GET", flaggedPath);
  const flaggedAuthed = await call("GET", flaggedPath, real);
  const flaggedItems =
    (JSON.parse(flaggedAuthed.text) as { items?: { id: string }[] }).items ??
    [];
  const flaggedDetail = await call(
    "GET",
    `/admin/requests/${request.request.id}`,
    real,
  );
  const detailReplies =
    (
      JSON.parse(flaggedDetail.text) as {
        replies?: { status: string; score: number; flagged: boolean }[];
      }
    ).replies ?? [];
  report(
    flaggedAnonymous.status === 401 &&
      flaggedAuthed.status === 200 &&
      flaggedItems.some((item) => item.id === request.request.id) &&
      detailReplies[0]?.score === 2.5 &&
      detailReplies[0]?.flagged === true,
    "A15-admin the admin API returns the flagged reply to staff and 401 without a token",
    `anonymous ${flaggedAnonymous.status}, staff ${flaggedAuthed.status}, ${flaggedItems.length} flagged request`,
  );

  const save = await call("PUT", "/admin/integrations/linear_api_key", real, {
    value: secret,
  });
  const listed = await call("GET", "/admin/integrations", real);
  const projectList = await call("GET", "/admin/projects", real);
  const requestList = await call("GET", "/admin/requests", real);

  const fromSm = await sm.send(
    new GetSecretValueCommand({ SecretId: secretId(scope, "linear-api-key") }),
  );
  report(
    save.status === 200 && fromSm.SecretString === secret,
    "A18a Secrets Manager holds the saved key",
    `save status ${save.status}`,
  );

  const dump = await dumpDatabase();
  report(
    dump.text.length > 1000 && !dump.text.includes(secret),
    "A18b the database dump holds no key material",
    `${dump.method}, ${dump.text.length} characters scanned`,
  );

  const leaked = [
    save.text,
    listed.text,
    projectList.text,
    requestList.text,
  ].some((text) => text.includes(secret));
  report(
    !leaked,
    "A18c no admin API response holds the key",
    "save, integrations, projects, requests",
  );

  await Bun.sleep(300);
  report(
    !logs.includes(secret) && logs.length > 0,
    "A18d the API logs hold no key",
    `${logs.length} characters of logs scanned`,
  );

  const eventRows = await db.select().from(events);
  report(
    !JSON.stringify(eventRows).includes(secret) &&
      eventRows.some((row) => row.type === "admin.integration.updated"),
    "A18e no event payload holds the key",
    `${eventRows.length} events scanned`,
  );
} catch (error) {
  failed = true;
  console.log(
    `FAIL validate:phase-4 crashed - ${error instanceof Error ? error.message : String(error)}`,
  );
  console.log(
    logs.split("\n").slice(-12).join("\n").replaceAll(secret, "<key>"),
  );
} finally {
  api.kill();
  policyApi.kill();
  await db
    .delete(projects)
    .where(eq(projects.projectSlug, slug))
    .catch(() => {});
  await db
    .delete(integrations)
    .where(eq(integrations.scope, scope))
    .catch(() => {});
  sm.destroy();
  await closeDb(db);
}

console.log(failed ? "validate:phase-4 FAILED" : "validate:phase-4 PASSED");
process.exit(failed ? 1 : 0);
