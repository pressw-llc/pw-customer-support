import type { ExtractRequest } from "./extract-core";

export const DEFAULT_EXTRACT_TIMEOUT_MS = 20_000;

export type SandboxResult =
  | { ok: true; text: string }
  | { ok: false; reason: "timeout" | "failed"; error?: string };

export interface SandboxOptions {
  timeoutMs?: number;
  workerUrl?: URL;
}

const DEFAULT_WORKER_URL = new URL("./extract-worker.ts", import.meta.url);

export function runExtractorIsolated(
  request: ExtractRequest,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const worker = new Worker(options.workerUrl ?? DEFAULT_WORKER_URL);
    const finish = (result: SandboxResult) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: "timeout" }),
      timeoutMs,
    );
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { ok: boolean; text?: string; error?: string };
      finish(
        data.ok
          ? { ok: true, text: data.text ?? "" }
          : { ok: false, reason: "failed", error: data.error },
      );
    };
    worker.onerror = (event: ErrorEvent) =>
      finish({ ok: false, reason: "failed", error: event.message });
    worker.postMessage(request);
  });
}
