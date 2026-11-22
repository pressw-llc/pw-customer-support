export interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

export class Steps {
  readonly results: StepResult[] = [];

  async run(name: string, body: () => Promise<unknown>) {
    try {
      const result = await body();
      const detail = typeof result === "string" ? result : "";
      this.results.push({ name, ok: true, detail });
      console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.results.push({ name, ok: false, detail });
      console.log(`FAIL ${name}: ${detail}`);
    }
  }

  summarize(): number {
    const failed = this.results.filter((result) => !result.ok);
    console.log(
      `\n${this.results.length - failed.length}/${this.results.length} steps passed`,
    );
    return failed.length === 0 ? 0 : 1;
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export interface Exec {
  code: number;
  out: string;
}

export async function exec(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<Exec> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: (options.env ?? process.env) as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${stdout}${stderr}` };
}

export async function waitFor(
  probe: () => Promise<boolean>,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
