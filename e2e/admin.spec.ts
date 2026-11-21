import { expect, type Page, test } from "@playwright/test";
import { hashCustomerId } from "@pw-support/contracts";
import { generateKeyPair, SignJWT } from "jose";
import { ADMIN, E2E } from "./playwright.config";
import { shot } from "./support";

test.describe.configure({ mode: "serial" });

async function seedRequest(text: string): Promise<{ customer: string }> {
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
  return { customer: hashed.slice(0, 8) };
}

async function signIn(page: Page): Promise<void> {
  await page.goto(ADMIN.url);
  await page.getByPlaceholder("Enter any user/subject").fill("ada-admin");
  await page
    .locator("textarea[name=claims]")
    .fill(JSON.stringify({ email: "ada@pressw.test", name: "Ada Admin" }));
  await page.getByRole("button", { name: "Sign-in" }).click();
  await expect(
    page.getByRole("heading", { name: "Requests", level: 1 }),
  ).toBeVisible();
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
  await shot(page, "admin-mobile-dark");
});
