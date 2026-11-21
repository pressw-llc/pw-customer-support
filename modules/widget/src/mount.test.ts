import { afterEach, expect, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import { installFakeApi } from "./testing/fake-api";

afterEach(() => {
  document.body.innerHTML = "";
});

test("the global bundle exposes PressWSupport.mount and unmounts cleanly", async () => {
  const api = installFakeApi();
  await import("./global");
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = window.PressWSupport?.mount(target, {
    projectKey: "pk_acme",
    userEmail: "ada@acme.test",
    apiUrl: "http://api.test",
  });
  expect(mounted).toBeDefined();
  await waitFor(() =>
    expect(
      target
        .querySelector("[data-pressw-support]")
        ?.shadowRoot?.querySelector("button"),
    ).not.toBeNull(),
  );
  mounted?.unmount();
  await waitFor(() =>
    expect(target.querySelector("[data-pressw-support]")).toBeNull(),
  );
  api.restore();
});
