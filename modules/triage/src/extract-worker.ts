import { type ExtractRequest, runExtractor } from "./extract-core";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<ExtractRequest>) => {
  try {
    self.postMessage({ ok: true, text: await runExtractor(event.data) });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
