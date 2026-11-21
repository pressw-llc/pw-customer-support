import { expect, test } from "bun:test";
import { createApp } from "./app";

test("GET /health returns ok", async () => {
  const response = await createApp().request("/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("an unknown route returns 404", async () => {
  const response = await createApp().request("/missing");
  expect(response.status).toBe(404);
});
