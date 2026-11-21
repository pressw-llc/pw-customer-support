import { expect, type Page, test } from "@playwright/test";
import {
  databaseView,
  openPanel,
  postStaffComment,
  shot,
  startNewRequest,
  stubComments,
  uniqueEmail,
  waitForInboundProcessed,
  waitForIssue,
  waitForStubComment,
} from "./support";

const POLL_MS = 1000;

async function submitRequest(page: Page, email: string, text: string) {
  await openPanel(page, email, POLL_MS);
  await startNewRequest(page);
  await page.getByLabel("How can we help?").fill(text);
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByRole("log", { name: "Conversation" })).toContainText(
    text,
  );
  const view = await databaseView(email);
  const issue = await waitForIssue(`Support request ID: ${view.requestId}`);
  return { requestId: view.requestId as string, issue };
}

async function closePanel(page: Page) {
  await page.getByRole("button", { name: "Back to requests" }).click();
  await page.getByRole("button", { name: "Close support" }).click();
}

test("A14: an unmarked staff comment never shows and an @external comment shows and raises the unread indicator", async ({
  page,
}) => {
  const email = uniqueEmail();
  const text = `Invoice question ${crypto.randomUUID().slice(0, 8)}`;
  const { requestId, issue } = await submitRequest(page, email, text);
  expect(issue.description).toContain(`> ${text}`);
  await closePanel(page);

  await postStaffComment(
    issue.id,
    "Internal note: Dave, check the billing job",
  );
  await waitForInboundProcessed(requestId, 1);
  await expect(
    page.getByRole("button", { name: "Open support", exact: true }),
  ).toBeVisible();

  await postStaffComment(
    issue.id,
    "@external Hi, your invoice was reissued today. Thank you for your patience.",
  );
  const launcher = page.getByRole("button", { name: "Open support, 1 unread" });
  await expect(launcher).toBeVisible({ timeout: 15_000 });
  await shot(page, "a14-unread-badge");

  await launcher.click();
  await page
    .getByRole("button", { name: /Hi, your invoice was reissued/ })
    .click();
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log).toContainText("Hi, your invoice was reissued today.");
  await expect(log).toContainText("Ada Staff (Support)");
  await expect(log).toContainText("via Linear");
  await expect(log).not.toContainText("Dave");
  await expect(log).not.toContainText("@external");
  await shot(page, "a14-thread-staff-reply");
  await expect(
    page.getByRole("button", { name: "Open support", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
});

test("A15: a low scored @external reply stays hidden until its author confirms", async ({
  page,
}) => {
  const email = uniqueEmail();
  const text = `Held reply question ${crypto.randomUUID().slice(0, 8)}`;
  const { requestId, issue } = await submitRequest(page, email, text);
  const held = await postStaffComment(
    issue.id,
    "@external Whatever, not our problem. [RUDE]",
  );
  await waitForInboundProcessed(requestId, 1);
  const warning = await waitForStubComment(
    issue.id,
    (comment) => comment.parentId === held.id,
  );
  expect(warning.body).toContain("Reply held, not sent to the customer.");
  await expect(
    page.getByRole("log", { name: "Conversation" }),
  ).not.toContainText("not our problem");

  await postStaffComment(issue.id, "@confirm", held.id);
  await expect(page.getByRole("log", { name: "Conversation" })).toContainText(
    "Whatever, not our problem. [RUDE]",
    { timeout: 15_000 },
  );
  await shot(page, "a15-confirmed-reply");
});

test("A16: a customer reply in the widget appears as a quoted comment on the ticket", async ({
  page,
}) => {
  const email = uniqueEmail();
  const text = `Follow-up question ${crypto.randomUUID().slice(0, 8)}`;
  const { issue } = await submitRequest(page, email, text);
  const followUp = `Order number ${crypto.randomUUID().slice(0, 6)} applies`;
  await page.getByLabel("Reply").fill(followUp);
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByRole("log", { name: "Conversation" })).toContainText(
    followUp,
  );
  const comment = await waitForStubComment(issue.id, (c) =>
    c.body.includes(followUp),
  );
  expect(comment.body.startsWith("Customer follow-up via widget")).toBe(true);
  expect(comment.body).toContain(`> ${followUp}`);
  const all = await stubComments(issue.id);
  expect(all.filter((c) => c.body.includes(followUp))).toHaveLength(1);
  await shot(page, "a16-follow-up");
});
