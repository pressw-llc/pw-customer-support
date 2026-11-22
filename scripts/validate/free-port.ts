export const emptyResponse = (): Response => new Response("");

export function freePort(): number {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: emptyResponse,
  });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("no free port");
  return port;
}
