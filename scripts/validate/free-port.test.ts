import { expect, test } from "bun:test";
import { emptyResponse, freePort } from "./free-port";

test("returns a port that can be bound right away and differs between calls", () => {
  const first = freePort();
  const held = Bun.serve({
    port: first,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  expect(held.port).toBe(first);
  expect(freePort()).not.toBe(first);
  held.stop(true);
  expect(emptyResponse().status).toBe(200);
});
