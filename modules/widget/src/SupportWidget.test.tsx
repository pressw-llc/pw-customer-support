import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { SupportWidget } from "./index";
import {
  type FakeApi,
  installFakeApi,
  message,
  summary,
} from "./testing/fake-api";
import type { Thread } from "./types";

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

afterEach(() => {
  cleanup();
  api.restore();
});

async function mountWidget(pollIntervalMs = 40) {
  const view = render(
    <SupportWidget
      projectKey="pk_acme"
      userEmail="ada@acme.test"
      apiUrl="http://api.test"
      pollIntervalMs={pollIntervalMs}
    />,
  );
  const host = view.container.querySelector(
    "[data-pressw-support]",
  ) as HTMLElement;
  await waitFor(() => expect(host.shadowRoot).not.toBeNull());
  const root = host.shadowRoot as unknown as HTMLElement;
  return { host, root, ui: within(root) };
}

async function openPanel(ui: ReturnType<typeof within>) {
  fireEvent.click(await ui.findByRole("button", { name: /open support/i }));
  return ui.findByRole("dialog");
}

function thread(id: string, messages: Thread["messages"]): Thread {
  return {
    id,
    status: "open",
    createdAt: "2026-01-01T12:00:00.000Z",
    messages,
  };
}

describe("shell", () => {
  test("A1: renders inside a shadow root with bundled styles and nothing in the host", async () => {
    const { host, root } = await mountWidget();
    expect(host.shadowRoot?.mode).toBe("open");
    expect(root.querySelector("style")?.textContent).toContain(":host");
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("style")).toBeNull();
  });

  test("shows an unread badge summed across requests", async () => {
    api.requests = [
      summary("r1", "one", { unreadCount: 2 }),
      summary("r2", "two", { unreadCount: 1 }),
    ];
    const { ui } = await mountWidget();
    const launcher = await ui.findByRole("button", {
      name: "Open support, 3 unread",
    });
    expect(launcher.textContent).toContain("3");
    expect(api.calls[0]?.headers["X-Support-Key"]).toBe("pk_acme");
  });

  test("caps the badge at 9+", async () => {
    api.requests = [summary("r1", "one", { unreadCount: 12 })];
    const { ui } = await mountWidget();
    const launcher = await ui.findByRole("button", { name: /unread/ });
    expect(launcher.textContent).toContain("9+");
  });

  test("opens a focused dialog, closes on Escape, and returns focus to the launcher", async () => {
    const { root, ui } = await mountWidget();
    const dialog = await openPanel(ui);
    expect((root as unknown as ShadowRoot).activeElement === dialog).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(ui.queryByRole("dialog")).toBeNull());
    const launcher = await ui.findByRole("button", { name: /open support/i });
    expect((root as unknown as ShadowRoot).activeElement === launcher).toBe(
      true,
    );
  });

  test("the close button closes the panel", async () => {
    const { ui } = await mountWidget();
    await openPanel(ui);
    fireEvent.click(ui.getByRole("button", { name: "Close support" }));
    await waitFor(() => expect(ui.queryByRole("dialog")).toBeNull());
  });
});

describe("request list", () => {
  test("shows the empty state", async () => {
    const { ui } = await mountWidget();
    await openPanel(ui);
    expect(await ui.findByText(/no requests yet/i)).toBeTruthy();
  });

  test("shows an error with a retry that recovers", async () => {
    api.failWith = 500;
    const { ui } = await mountWidget();
    await openPanel(ui);
    expect(await ui.findByText(/something went wrong/i)).toBeTruthy();
    api.failWith = null;
    api.requests = [summary("r1", "Recovered request")];
    fireEvent.click(ui.getByRole("button", { name: "Try again" }));
    expect(await ui.findByText("Recovered request")).toBeTruthy();
  });

  test("explains rate limiting", async () => {
    api.failWith = 429;
    const { ui } = await mountWidget();
    await openPanel(ui);
    expect(await ui.findByText(/too many requests/i)).toBeTruthy();
  });

  test("lists requests with an unread dot", async () => {
    api.requests = [
      summary("r1", "Export fails", { unreadCount: 1 }),
      summary("r2", "Billing question"),
    ];
    const { ui } = await mountWidget();
    await openPanel(ui);
    const list = await ui.findByRole("list", { name: "Your requests" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(within(list).getByRole("img", { name: "1 unread" })).toBeTruthy();
  });

  test("a request without messages still has a title", async () => {
    api.requests = [summary("r1", "", { lastMessage: null })];
    const { ui } = await mountWidget();
    await openPanel(ui);
    expect(await ui.findByText("Request")).toBeTruthy();
  });
});

describe("new request", () => {
  async function startNew() {
    const mounted = await mountWidget();
    await openPanel(mounted.ui);
    fireEvent.click(
      await mounted.ui.findByRole("button", { name: "New request" }),
    );
    return mounted;
  }

  test("A2: submits text and two files, then shows the thread", async () => {
    const { ui } = await startNew();
    fireEvent.change(ui.getByLabelText("How can we help?"), {
      target: { value: "My export fails" },
    });
    const files = [
      new File(["png"], "shot.png", { type: "image/png" }),
      new File(["log"], "app.log", { type: "text/plain" }),
    ];
    fireEvent.change(ui.getByLabelText("Attachments"), {
      target: { files },
    });
    expect(await ui.findByText(/2 of 10 files/)).toBeTruthy();
    fireEvent.click(ui.getByRole("button", { name: "Send request" }));
    expect(await ui.findByRole("log", { name: "Conversation" })).toBeTruthy();
    expect(await ui.findByText("My export fails")).toBeTruthy();
    const post = api.calls.find(
      (call) => call.method === "POST" && call.path === "/v1/requests",
    );
    expect(post?.body?.get("text")).toBe("My export fails");
    expect(post?.body?.getAll("files")).toHaveLength(2);
  });

  test("A4: shows server rejections for individual files", async () => {
    api.createFiles = [
      { filename: "invoice.pdf", status: "rejected", reason: "executable" },
      { filename: "ok.png", status: "stored" },
    ];
    const { ui } = await startNew();
    fireEvent.change(ui.getByLabelText("How can we help?"), {
      target: { value: "see attached" },
    });
    fireEvent.change(ui.getByLabelText("Attachments"), {
      target: {
        files: [new File(["MZ"], "invoice.pdf"), new File(["x"], "ok.png")],
      },
    });
    fireEvent.click(ui.getByRole("button", { name: "Send request" }));
    const alert = await ui.findByRole("alert");
    expect(alert.textContent).toContain("invoice.pdf");
    expect(alert.textContent).toContain(
      "programs and scripts are not accepted",
    );
    expect(alert.textContent).not.toContain("ok.png");
  });

  test("hints at limits and lets the customer remove a file", async () => {
    const { ui } = await startNew();
    const big = new File(["x"], "huge.mov");
    Object.defineProperty(big, "size", { value: 26 * 1024 * 1024 });
    const many = Array.from(
      { length: 10 },
      (_, i) => new File(["x"], `f${i}.txt`),
    );
    fireEvent.change(ui.getByLabelText("Attachments"), {
      target: { files: [big, ...many] },
    });
    expect(await ui.findByText(/huge.mov is over 25 MB/)).toBeTruthy();
    expect(ui.getByText(/Only the first 10 files/)).toBeTruthy();
    fireEvent.click(ui.getByRole("button", { name: "Remove huge.mov" }));
    await waitFor(() => expect(ui.queryByText(/huge.mov is over/)).toBeNull());
    expect(ui.getByText(/10 of 10 files/)).toBeTruthy();
  });

  test("keeps the draft and shows an error when sending fails", async () => {
    const { ui } = await startNew();
    api.failWith = 500;
    const box = ui.getByLabelText("How can we help?") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "keep this text" } });
    fireEvent.click(ui.getByRole("button", { name: "Send request" }));
    expect(await ui.findByText(/something went wrong/i)).toBeTruthy();
    expect(box.value).toBe("keep this text");
  });

  test("the send button is disabled until there is text", async () => {
    const { ui } = await startNew();
    const send = ui.getByRole("button", {
      name: "Send request",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(ui.getByLabelText("How can we help?"), {
      target: { value: "hi" },
    });
    expect(send.disabled).toBe(false);
    fireEvent.submit(send.closest("form") as HTMLFormElement);
  });

  test("the back button returns to the list", async () => {
    const { ui } = await startNew();
    fireEvent.click(ui.getByRole("button", { name: "Back to requests" }));
    expect(await ui.findByRole("button", { name: "New request" })).toBeTruthy();
  });
});

describe("thread", () => {
  test("shows who replied, from which channel, and marks the thread read", async () => {
    api.requests = [summary("r1", "Export fails", { unreadCount: 1 })];
    api.threads.r1 = thread("r1", [
      message("m1", "Export fails"),
      message("m2", "We fixed it", {
        author: "staff",
        originChannel: "slack",
        flagged: true,
      }),
    ]);
    const { ui } = await mountWidget();
    await openPanel(ui);
    fireEvent.click(await ui.findByRole("button", { name: /Export fails/ }));
    const log = await ui.findByRole("log", { name: "Conversation" });
    await waitFor(() =>
      expect(within(log).getAllByRole("listitem").length).toBe(2),
    );
    expect(log.textContent).toContain("Support");
    expect(log.textContent).toContain("via Slack");
    expect(log.textContent).toContain("Some formatting was removed");
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.path === "/v1/requests/r1/read"),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        ui
          .getByRole("button", { name: /open support/i })
          .getAttribute("aria-label"),
      ).toBe("Open support"),
    );
  });

  test("a reply is sent and appears in the thread", async () => {
    api.requests = [summary("r1", "Question")];
    api.threads.r1 = thread("r1", [message("m1", "Question")]);
    const { ui } = await mountWidget();
    await openPanel(ui);
    fireEvent.click(await ui.findByRole("button", { name: /Question/ }));
    await ui.findByRole("log", { name: "Conversation" });
    fireEvent.change(await ui.findByLabelText("Reply"), {
      target: { value: "Thanks, one more detail" },
    });
    fireEvent.click(ui.getByRole("button", { name: "Send reply" }));
    expect(await ui.findByText("Thanks, one more detail")).toBeTruthy();
    const post = api.calls.find((call) => call.path.endsWith("/r1/messages"));
    expect(post?.body?.get("text")).toBe("Thanks, one more detail");
  });

  test("polling shows a staff reply that arrives while the thread is open", async () => {
    api.requests = [summary("r1", "Question")];
    api.threads.r1 = thread("r1", [message("m1", "Question")]);
    const { ui } = await mountWidget(30);
    await openPanel(ui);
    fireEvent.click(await ui.findByRole("button", { name: /Question/ }));
    await ui.findByRole("log", { name: "Conversation" });
    api.threads.r1?.messages.push(
      message("m2", "Arrived by polling", {
        author: "staff",
        originChannel: "linear",
      }),
    );
    expect(await ui.findByText("Arrived by polling")).toBeTruthy();
  });

  test("shows an error when the thread cannot load", async () => {
    api.requests = [summary("r1", "Gone")];
    const { ui } = await mountWidget();
    await openPanel(ui);
    fireEvent.click(await ui.findByRole("button", { name: /Gone/ }));
    expect(await ui.findByText(/something went wrong/i)).toBeTruthy();
  });

  test("downloads an attachment through an authenticated fetch", async () => {
    api.requests = [summary("r1", "With file")];
    api.threads.r1 = thread("r1", [
      message("m1", "With file", {
        attachments: [
          {
            id: "a1",
            filename: "shot.png",
            contentType: "image/png",
            sizeBytes: 2048,
          },
        ],
      }),
    ]);
    const created: string[] = [];
    URL.createObjectURL = () => {
      created.push("blob:test");
      return "blob:test";
    };
    URL.revokeObjectURL = () => {};
    const { ui } = await mountWidget();
    await openPanel(ui);
    fireEvent.click(await ui.findByRole("button", { name: /With file/ }));
    fireEvent.click(
      await ui.findByRole("button", { name: /shot.png \(2.0 KB\)/ }),
    );
    await waitFor(() => expect(created).toHaveLength(1));
    expect(api.calls.some((call) => call.path === "/v1/attachments/a1")).toBe(
      true,
    );
  });

  test("reports a failed attachment download", async () => {
    api.requests = [summary("r1", "With file")];
    api.threads.r1 = thread("r1", [
      message("m1", "With file", {
        attachments: [
          {
            id: "a1",
            filename: "shot.png",
            contentType: "image/png",
            sizeBytes: 10,
          },
        ],
      }),
    ]);
    const { ui } = await mountWidget();
    await openPanel(ui);
    fireEvent.click(await ui.findByRole("button", { name: /With file/ }));
    const link = await ui.findByRole("button", { name: /shot.png/ });
    URL.createObjectURL = () => {
      throw new Error("blocked");
    };
    fireEvent.click(link);
    expect(await ui.findByText(/Download failed/)).toBeTruthy();
  });
});
