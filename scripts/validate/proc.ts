import type { Subprocess } from "bun";

export interface Managed {
  name: string;
  proc: Subprocess;
  output: () => string;
  stop: () => Promise<void>;
}

export function startProcess(
  name: string,
  command: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    quiet?: boolean;
  } = {},
): Managed {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  let buffer = "";
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      buffer = (buffer + text).slice(-20_000);
      if (!options.quiet) {
        for (const line of text.split("\n").filter(Boolean)) {
          console.log(`[${name}] ${line}`);
        }
      }
    }
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);
  return {
    name,
    proc,
    output: () => buffer,
    stop: async () => {
      proc.kill("SIGTERM");
      const done = await Promise.race([
        proc.exited,
        Bun.sleep(5_000).then(() => "timeout"),
      ]);
      if (done === "timeout") proc.kill("SIGKILL");
    },
  };
}

export async function waitForHttp(
  url: string,
  accept: (response: Response) => boolean = (response) => response.ok,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (accept(response)) return;
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(400);
  }
  throw new Error(`${url} not ready: ${last}`);
}
