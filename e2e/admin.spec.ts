import { expect, type Page, test } from "@playwright/test";
import { hashCustomerId } from "@pw-support/contracts";
import { generateKeyPair, SignJWT } from "jose";
import { ADMIN, E2E } from "./playwright.config";
import {
  postStaffComment,
  shot,
  waitForInboundProcessed,
  waitForIssue,
  waitForStubComment,
} from "./support";

test.describe.configure({ mode: "serial" });

async function seedRequest(
  text: string,
): Promise<{ customer: string; requestId: string }> {
  const email = `grace-${crypto.randomUUID().slice(0, 6)}@acme.test`;
  const hashed = await hashCustomerId(email, E2E.projectKey);
  const body = new FormData();
  body.set("text", text);
  const response = await fetch(`${ADMIN.apiUrl}/v1/requests`, {
    method: "POST",
    headers: { "X-Support-Key": E2E.projectKey, "X-Support-User": hashed },
    body,
  });
  expect(response.status).toBe(201);
  const created = (await response.json()) as { requestId: string };
  return { customer: hashed.slice(0, 8), requestId: created.requestId };
}

async function ticketFor(requestId: string) {
  return waitForIssue(`Support request ID: ${requestId}`);
}

async function submitLoginForm(
  page: Page,
  email = "ada@pressw.test",
): Promise<void> {
  await page.getByPlaceholder("Enter any user/subject").fill(email);
  await page
    .locator("textarea[name=claims]")
    .fill(JSON.stringify({ email, name: "Ada Admin" }));
  await page.getByRole("button", { name: "Sign-in" }).click();
}

async function signIn(page: Page): Promise<void> {
  await page.goto(ADMIN.url);
  await submitLoginForm(page);
  await expect(
    page.getByRole("heading", { name: "Requests", level: 1 }),
  ).toBeVisible();
}

async function runtimeConfig(
  page: Page,
  values: Record<string, string>,
): Promise<void> {
  await page.route("**/config.json", (route) =>
    route.fulfill({ json: values }),
  );
}

function countAuthorizeRequests(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    const url = request.url();
    if (
      request.method() === "GET" &&
      url.startsWith(ADMIN.issuer) &&
      new URL(url).pathname.endsWith("/authorize")
    ) {
      count += 1;
    }
  });
  return () => count;
}

test("A19: an admin route returns 401 without a token and with a forged token", async () => {
  const none = await fetch(`${ADMIN.apiUrl}/admin/requests`);
  expect(none.status).toBe(401);
  const { privateKey } = await generateKeyPair("RS256");
  const forged = await new SignJWT({ sub: "attacker", aud: ADMIN.clientId })
    .setProtectedHeader({ alg: "RS256", kid: "support" })
    .setIssuer(ADMIN.issuer)
    .setExpirationTime("5m")
    .sign(privateKey);
  for (const path of ["/admin/requests", "/admin/projects", "/admin/me"]) {
    const response = await fetch(`${ADMIN.apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${forged}` },
    });
    expect(response.status).toBe(401);
  }
});

test("A19: a staff member logs in through the mock issuer and sees the request list with a running timer", async ({
  page,
}) => {
  const { customer } = await seedRequest("My invoice export is failing");
  await signIn(page);
  const row = page.getByRole("row").filter({ hasText: customer });
  await expect(row).toBeVisible();
  await expect(row.getByText("My invoice export is failing")).toBeVisible();
  const timer = row.getByTestId("ack-timer");
  await expect(timer).toHaveAttribute("data-state", "waiting");
  const first = await timer.textContent();
  await expect
    .poll(async () => timer.textContent(), { timeout: 5000 })
    .not.toBe(first);
  await shot(page, "admin-requests");

  await row.getByRole("link", { name: /invoice export/ }).click();
  await expect(
    page.getByRole("heading", { name: /invoice export/, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Customer visible").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(page.getByText("request created")).toBeVisible();
  await shot(page, "admin-request-detail");
});

test("A19: the access token stays out of localStorage", async ({ page }) => {
  await signIn(page);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain("eyJ");
});

test("A18: a saved Linear key shows as configured and its value appears nowhere", async ({
  page,
}) => {
  const secret = `lin_api_${crypto.randomUUID().replaceAll("-", "")}`;
  const bodies: string[] = [];
  page.on("response", async (response) => {
    if (!response.url().startsWith(ADMIN.apiUrl)) return;
    bodies.push(await response.text().catch(() => ""));
  });
  await signIn(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Integrations" }).click();
  const status = page.getByTestId("status-linear_api_key");
  await expect(status).toHaveText("Not configured");
  await page.getByLabel("Value").first().fill(secret);
  await shot(page, "admin-integrations-before");
  await page
    .locator('[data-kind="linear_api_key"]')
    .getByRole("button", { name: "Save" })
    .click();
  await expect(status).toContainText("Configured · updated");
  await expect(status).toContainText("ada@pressw.test");
  await shot(page, "admin-integrations-after");

  await page.reload();
  await expect(page.getByTestId("status-linear_api_key")).toContainText(
    "Configured",
  );
  const html = await page.content();
  const fields = await page
    .locator("input")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLInputElement).value).join("|"),
    );
  expect(html).not.toContain(secret);
  expect(fields).not.toContain(secret);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.join("\n")).not.toContain(secret);
});

test("A29: a saved CC list survives a reload", async ({ page }) => {
  await signIn(page);
  await page.goto(`${ADMIN.url}/settings/projects`);
  await page.getByRole("button", { name: /acme\/e2e$/ }).click();
  await page.getByLabel("Email address").fill("lead@acme.test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Email address").fill("oncall@acme.test");
  await page.getByLabel("Email address").press("Enter");
  await page.getByLabel("Email address").fill("not-an-email");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await page.getByRole("button", { name: "Save CC list" }).click();
  await expect(page.getByText("CC list saved")).toBeVisible();
  await shot(page, "admin-cc-list");

  await page.reload();
  await page.getByRole("button", { name: /acme\/e2e$/ }).click();
  const list = page.getByRole("list", { name: "CC recipients" });
  await expect(list).toContainText("lead@acme.test");
  await expect(list).toContainText("oncall@acme.test");
});

test("creates a project, mints and revokes a key, and saves the Linear team mapping", async ({
  page,
}) => {
  const slug = `p${Date.now().toString(36)}`;
  await signIn(page);
  await page.goto(`${ADMIN.url}/settings/projects`);
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("dialog").getByLabel("Client slug").fill("acme");
  await page.getByRole("dialog").getByLabel("Project slug").fill(slug);
  await page.getByRole("dialog").getByLabel("Display name").fill("Portal e2e");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(
    page.getByRole("heading", { name: `acme/${slug}` }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Mint key" }).click();
  const minted = page.getByTestId("minted-key");
  await expect(minted).toContainText("pk_");
  const key = ((await minted.textContent()) ?? "").trim();
  await shot(page, "admin-key-minted");
  await page.getByRole("button", { name: "I have copied it" }).click();
  await expect(page.getByText("pk_••••")).toBeVisible();
  const accepted = await fetch(`${ADMIN.apiUrl}/v1/requests`, {
    headers: { "X-Support-Key": key, "X-Support-User": "a".repeat(64) },
  });
  expect(accepted.status).toBe(200);

  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(page.getByText(/revoked/)).toBeVisible();
  const denied = await fetch(`${ADMIN.apiUrl}/v1/requests`, {
    headers: { "X-Support-Key": key, "X-Support-User": "a".repeat(64) },
  });
  expect(denied.status).toBe(401);

  await page.getByLabel("Linear team ID").fill("team-e2e-1");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Details saved")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: new RegExp(`acme/${slug}`) }).click();
  await expect(page.getByLabel("Linear team ID")).toHaveValue("team-e2e-1");
  await shot(page, "admin-projects");
});

test("a signed-in user can sign out and is asked to sign in again", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(
    page.getByRole("heading", { name: /signed out|Sign/ }).first(),
  ).toBeVisible();
  await shot(page, "admin-signed-out");
});

test("the layout works on a phone and in the dark theme", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page);
  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.waitForTimeout(400);
  await shot(page, "admin-mobile-dark");
});

test("A15: a reply scored 2.5 sends and shows a flag in the admin UI", async ({
  page,
}) => {
  const { customer, requestId } = await seedRequest(
    `Flag question ${crypto.randomUUID().slice(0, 8)}`,
  );
  const issue = await ticketFor(requestId);
  await postStaffComment(
    issue.id,
    "@external Thanks for waiting, we are on it. [BORDER]",
  );
  await waitForInboundProcessed(requestId, 1);

  await signIn(page);
  await page.getByLabel("Flagged replies").check();
  const row = page.getByRole("row").filter({ hasText: customer });
  await expect(row).toBeVisible();
  await expect(row.getByText("Flagged reply")).toBeVisible();
  await expect(row.getByText("Held reply")).toHaveCount(0);

  await row.getByRole("link").first().click();
  const reply = page.getByTestId("reply-item");
  await expect(reply).toHaveAttribute("data-status", "sent");
  await expect(reply).toHaveAttribute("data-flagged", "true");
  await expect(reply.getByTestId("reply-score")).toHaveText("score 2.50");
  await expect(reply.getByText("Flagged", { exact: true })).toBeVisible();
  await expect(page.getByText("Ada Staff").first()).toBeVisible();
  await shot(page, "admin-a15-flag");
});

test("A15: a held reply shows as held with its score until it is confirmed", async ({
  page,
}) => {
  const { customer, requestId } = await seedRequest(
    `Hold question ${crypto.randomUUID().slice(0, 8)}`,
  );
  const issue = await ticketFor(requestId);
  const held = await postStaffComment(
    issue.id,
    "@external Not our problem at all. [RUDE]",
  );
  await waitForInboundProcessed(requestId, 1);
  await waitForStubComment(issue.id, (comment) => comment.parentId === held.id);

  await signIn(page);
  const row = page.getByRole("row").filter({ hasText: customer });
  await expect(row.getByText("Held reply")).toBeVisible();
  await row.getByRole("link").first().click();
  const reply = page.getByTestId("reply-item");
  await expect(reply).toHaveAttribute("data-status", "held");
  await expect(reply.getByTestId("reply-score")).toHaveText("score 1.00");
  await expect(reply.getByText("wording low")).toBeVisible();
  await expect(reply.getByText("posted in the thread")).toBeVisible();
  await expect(page.getByText("Customer visible")).toHaveCount(1);
  await shot(page, "admin-a15-hold");

  await postStaffComment(issue.id, "@confirm", held.id);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("reply-item")).toHaveAttribute(
      "data-status",
      "sent",
    );
  }).toPass({ timeout: 20_000 });
});

test("thread bodies, author names, and event payloads render as inert text", async ({
  page,
}) => {
  const marker = crypto.randomUUID().slice(0, 8);
  const img = `<img src=x onerror="window.__xss='img'">`;
  const custom = `<x-a onmouseover="window.__xss='custom'">hover ${marker}</x-a>`;
  const { requestId } = await seedRequest(
    `Customer ${marker} ${img} ${custom}`,
  );
  const issue = await ticketFor(requestId);
  await postStaffComment(issue.id, `Internal note ${marker} ${img} ${custom}`);
  await waitForInboundProcessed(requestId, 1);

  await signIn(page);
  await page.goto(`${ADMIN.url}/requests/${requestId}`);
  const thread = page.getByRole("heading", { name: "Thread" }).locator("..");
  const internal = thread.locator('[data-audience="internal"]');
  await expect(internal).toContainText(`Internal note ${marker}`);
  await expect(internal).toContainText(img);
  await expect(internal).toContainText(custom);
  await internal.getByText(`hover ${marker}`).hover();
  await expect(page.locator("main img, x-a")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as { __xss?: string }).__xss)).toBe(
    undefined,
  );
  await shot(page, "admin-xss-inert");
});

test("a signed-in user outside the allowed domain sees a not-authorized page and no login loop", async ({
  page,
}) => {
  await runtimeConfig(page, { VITE_API_URL: ADMIN.policyApiUrl });
  const authorizations = countAuthorizeRequests(page);
  await page.goto(ADMIN.url);
  await submitLoginForm(page, "eve@other.test");
  await expect(
    page.getByRole("heading", { name: "Not authorized for this desk" }),
  ).toBeVisible();
  await expect(page.getByText("eve@other.test")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(authorizations()).toBe(1);
  expect(new URL(page.url()).origin).toBe(ADMIN.url);
  await shot(page, "admin-not-authorized");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "You are signed out" }),
  ).toBeVisible();
});

test("an allowed domain still signs in against the policy API", async ({
  page,
}) => {
  await runtimeConfig(page, { VITE_API_URL: ADMIN.policyApiUrl });
  await page.goto(ADMIN.url);
  await submitLoginForm(page, `ada@${ADMIN.allowedDomain}`);
  await expect(
    page.getByRole("heading", { name: "Requests", level: 1 }),
  ).toBeVisible();
});

test("a persistent 401 triggers one re-login and then a terminal page", async ({
  page,
}) => {
  await runtimeConfig(page, { VITE_API_URL: ADMIN.audienceApiUrl });
  const authorizations = countAuthorizeRequests(page);
  await page.goto(ADMIN.url);
  await submitLoginForm(page);
  await submitLoginForm(page);
  await expect(
    page.getByRole("heading", { name: "Sign-in could not be verified" }),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  expect(authorizations()).toBe(2);
  expect(new URL(page.url()).origin).toBe(ADMIN.url);
  await shot(page, "admin-unverified");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a callback error from the issuer ends on a visible page without another login", async ({
  page,
}) => {
  const authorizations = countAuthorizeRequests(page);
  await page.goto(
    `${ADMIN.url}/auth/callback?error=access_denied&error_description=denied&state=missing`,
  );
  await expect(
    page.getByRole("heading", { name: "Sign-in failed" }),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  expect(authorizations()).toBe(0);
});

test("a callback with an unknown state ends on a visible page without another login", async ({
  page,
}) => {
  const authorizations = countAuthorizeRequests(page);
  await page.goto(`${ADMIN.url}/auth/callback?code=abc&state=expired`);
  await expect(
    page.getByRole("heading", { name: "Sign-in failed" }),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  expect(authorizations()).toBe(0);
});

async function withoutEndSession(page: Page): Promise<void> {
  await page.route(
    `${ADMIN.issuer}/.well-known/openid-configuration`,
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      delete body.end_session_endpoint;
      await route.fulfill({ response, json: body });
    },
  );
}

async function storedOidcKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(sessionStorage).filter((key) => key.startsWith("oidc.")),
  );
}

test("sign out sends the browser to the issuer end-session endpoint and requires a new login", async ({
  page,
}) => {
  await signIn(page);
  const endSession = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/support/endsession",
  );
  await page.getByRole("button", { name: "Sign out" }).first().click();
  const url = new URL((await endSession).url());
  expect(url.origin).toBe(new URL(ADMIN.issuer).origin);
  expect(url.searchParams.get("post_logout_redirect_uri")).toBe(
    `${ADMIN.url}/signed-out`,
  );
  expect(url.searchParams.get("id_token_hint")).toMatch(/^eyJ/);
  await expect(
    page.getByRole("heading", { name: "You are signed out" }),
  ).toBeVisible();
  await expect(page.getByText("may still be active")).toHaveCount(0);
  expect(await storedOidcKeys(page)).toEqual([]);

  await page.goto(ADMIN.url);
  await expect(page.getByText("Mock OAuth2 Server Sign-in")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Requests", level: 1 }),
  ).toHaveCount(0);
});

test("sign out uses the configured Cognito logout URL when discovery has no end-session endpoint", async ({
  page,
}) => {
  const hostedUi = `${new URL(ADMIN.issuer).origin}/support/logout`;
  await withoutEndSession(page);
  await runtimeConfig(page, {
    VITE_API_URL: ADMIN.apiUrl,
    VITE_OIDC_LOGOUT_URL: `${hostedUi}?client_id={client_id}&logout_uri={logout_uri}`,
  });
  await page.route(`${hostedUi}**`, (route) =>
    route.fulfill({
      status: 302,
      headers: { Location: `${ADMIN.url}/signed-out` },
    }),
  );
  await page.goto(ADMIN.url);
  await submitLoginForm(page);
  await expect(
    page.getByRole("heading", { name: "Requests", level: 1 }),
  ).toBeVisible();
  const logout = page.waitForRequest((request) =>
    request.url().startsWith(hostedUi),
  );
  await page.getByRole("button", { name: "Sign out" }).first().click();
  const url = new URL((await logout).url());
  expect(url.pathname).toBe("/support/logout");
  expect(url.searchParams.get("client_id")).toBe(ADMIN.clientId);
  expect(url.searchParams.get("logout_uri")).toBe(`${ADMIN.url}/signed-out`);
  await expect(
    page.getByRole("heading", { name: "You are signed out" }),
  ).toBeVisible();
  await expect(page.getByText("may still be active")).toHaveCount(0);
  expect(await storedOidcKeys(page)).toEqual([]);
});

test("sign out without any logout endpoint warns that the issuer session may remain and never auto-signs in", async ({
  page,
}) => {
  await withoutEndSession(page);
  await signIn(page);
  const authorizations = countAuthorizeRequests(page);
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(
    page.getByRole("heading", { name: "You are signed out" }),
  ).toBeVisible();
  await expect(page.getByText("may still be active")).toBeVisible();
  await expect(page.getByText(/Close this browser/)).toBeVisible();
  expect(await storedOidcKeys(page)).toEqual([]);
  await page.reload();
  await expect(page.getByText("may still be active")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(authorizations()).toBe(0);
  await shot(page, "admin-signed-out-idp-warning");
});
