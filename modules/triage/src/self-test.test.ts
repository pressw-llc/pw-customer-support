import { describe, expect, test } from "bun:test";
import { runExtractionSelfTest } from "./self-test";

describe("extraction self-test", () => {
  test("extracts the built-in fixtures through the real Worker", async () => {
    await expect(runExtractionSelfTest()).resolves.toBeUndefined();
  });

  test("fails when the worker cannot answer in time", async () => {
    await expect(
      runExtractionSelfTest({
        workerUrl: new URL("./testing/hang-worker.ts", import.meta.url),
        timeoutMs: 200,
      }),
    ).rejects.toThrow("extraction self-test failed for pdf: timeout");
  });

  test("fails when the worker file is missing", async () => {
    await expect(
      runExtractionSelfTest({
        workerUrl: new URL("./missing-worker.ts", import.meta.url),
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("extraction self-test failed");
  });
});
