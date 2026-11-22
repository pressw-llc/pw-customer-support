export function freePort(): number {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("no free port");
  return port;
}
