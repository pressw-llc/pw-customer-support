import { expect, test } from "@playwright/test";
import {
  databaseView,
  elfBytes,
  insertStaffReply,
  openPanel,
  pngBytes,
  shot,
  startNewRequest,
  uniqueEmail,
  widgetHost,
} from "./support";

test("A1: the widget renders from the host app inside a shadow root", async ({
  page,
}) => {
  await page.goto(`/?email=${encodeURIComponent(uniqueEmail())}`);
  const launcher = page.getByRole("button", { name: /open support/i });
  await expect(launcher).toBeVisible();
  const host = widgetHost(page);
  expect(await host.evaluate((el) => el.shadowRoot !== null)).toBe(true);
  expect(await host.evaluate((el) => el.children.length)).toBe(0);
  expect(
    await host.evaluate((el) => el.shadowRoot?.querySelector("style") !== null),
  ).toBe(true);
  await shot(page, "a1-launcher");
});

test("A1: the widget stays usable under hostile host CSS", async ({ page }) => {
  await page.goto(`/?email=${encodeURIComponent(uniqueEmail())}`);
  await page.addStyleTag({
    content: `
      * { color: red !important; font-family: fantasy !important; font-size: 40px !important; }
      button { display: none !important; }
      textarea, input { display: none !important; }
    `,
  });
  const launcher = page.getByRole("button", { name: /open support/i });
  await expect(launcher).toBeVisible();
  await launcher.click();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await startNewRequest(page);
  await expect(page.getByLabel("How can we help?")).toBeVisible();
  const styles = await panel.evaluate((el) => {
    const computed = getComputedStyle(el);
    return {
      font: computed.fontFamily,
      color: computed.color,
      size: computed.fontSize,
    };
  });
  expect(styles.font).not.toContain("fantasy");
  expect(styles.color).not.toBe("rgb(255, 0, 0)");
  expect(styles.size).toBe("14px");
  await shot(page, "a1-hostile-css");
});

test("A2: text with two attachments persists the request, files, and request.created", async ({
  page,
}) => {
  const email = uniqueEmail();
  await openPanel(page, email);
  await startNewRequest(page);
  await page
    .getByLabel("How can we help?")
    .fill("My export fails with an error");
  await page.getByLabel("Attachments").setInputFiles([
    { name: "screenshot.png", mimeType: "image/png", buffer: pngBytes() },
    { name: "app.log", mimeType: "text/plain", buffer: Buffer.from("boom\n") },
  ]);
  await expect(page.getByText("2 of 10 files")).toBeVisible();
  await shot(page, "a2-new-request-form");
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
  await expect(page.getByText("My export fails with an error")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /screenshot.png/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /app.log/ })).toBeVisible();
  await shot(page, "a2-thread");

  const view = await databaseView(email);
  expect(view.requestCount).toBe(1);
  expect(view.filenames).toEqual(["app.log", "screenshot.png"]);
  expect(view.eventTypes).toContain("request.created");
});

test("A4: a renamed executable shows a rejection in the UI", async ({
  page,
}) => {
  const email = uniqueEmail();
  await openPanel(page, email);
  await startNewRequest(page);
  await page.getByLabel("How can we help?").fill("See the attached invoice");
  await page.getByLabel("Attachments").setInputFiles([
    { name: "invoice.pdf", mimeType: "application/pdf", buffer: elfBytes() },
    { name: "ok.png", mimeType: "image/png", buffer: pngBytes() },
  ]);
  await page.getByRole("button", { name: "Send request" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("invoice.pdf");
  await expect(alert).toContainText("programs and scripts are not accepted");
  await expect(alert).not.toContainText("ok.png");
  await shot(page, "a4-rejection");

  const view = await databaseView(email);
  expect(view.filenames).toEqual(["ok.png"]);
  expect(view.eventTypes).toContain("attachment.rejected");
});

test("the thread shows the message and a follow-up reply works", async ({
  page,
}) => {
  const email = uniqueEmail();
  await openPanel(page, email);
  await startNewRequest(page);
  await page.getByLabel("How can we help?").fill("Where is my invoice?");
  await page.getByRole("button", { name: "Send request" }).click();
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log).toContainText("Where is my invoice?");
  await page.getByLabel("Reply").fill("Adding the order number 4412");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(log).toContainText("Adding the order number 4412");
  await shot(page, "thread-follow-up");

  const view = await databaseView(email);
  expect(
    view.eventTypes.filter((type) =>
      ["request.created", "triage.job.opened", "message.created"].includes(
        type,
      ),
    ),
  ).toEqual(["request.created", "triage.job.opened", "message.created"]);
});

test("a staff reply raises the unread badge and opening the thread clears it", async ({
  page,
}) => {
  const email = uniqueEmail();
  await openPanel(page, email);
  await startNewRequest(page);
  await page.getByLabel("How can we help?").fill("Question for support");
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
  const view = await databaseView(email);
  await insertStaffReply(view.requestId ?? "", "Here is the answer");

  await page.reload();
  const launcher = page.getByRole("button", { name: "Open support, 1 unread" });
  await expect(launcher).toBeVisible();
  await shot(page, "unread-badge");
  await launcher.click();
  await page
    .getByRole("button", { name: /Question for support|Here is the answer/ })
    .click();
  await expect(page.getByRole("log", { name: "Conversation" })).toContainText(
    "via Slack",
  );
  await expect(
    page.getByRole("button", { name: "Open support", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await shot(page, "thread-staff-reply");
});
