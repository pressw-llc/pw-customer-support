import { describe, expect, test } from "bun:test";
import { adapterDlqName, adapterQueueName } from "./channel-adapter";
import {
  buildWakeMessage,
  delayChannelFor,
  halveDelay,
  humanTriageResult,
  loadTimingConfig,
  wakeMessageSchema,
} from "./triage-job";
import { triageResultSchema } from "./triage-result";

describe("triage job contracts", () => {
  test("the delay halves with integer floor down to zero", () => {
    const seen: number[] = [];
    for (let delay = 60; seen.length < 8; delay = halveDelay(delay)) {
      seen.push(delay);
    }
    expect(seen).toEqual([60, 30, 15, 7, 3, 1, 0, 0]);
  });

  test("the delay channel is client:project", () => {
    expect(delayChannelFor("acme:portal:abc")).toBe("acme:portal");
    expect(delayChannelFor("acme:portal")).toBe("acme:portal");
    expect(delayChannelFor("acme")).toBe("acme");
  });

  test("the human triage result passes the triage result schema", () => {
    expect(triageResultSchema.safeParse(humanTriageResult()).success).toBe(
      true,
    );
  });

  test("a wake message carries the job id in the pipeline envelope", () => {
    const message = buildWakeMessage("7d444840-9dc0-4d3f-a2f8-6f4f7a5f9a11");
    expect(wakeMessageSchema.parse(message).input.jobId).toBe(
      "7d444840-9dc0-4d3f-a2f8-6f4f7a5f9a11",
    );
  });

  test("timing config reads overrides and falls back on bad input", () => {
    expect(loadTimingConfig({})).toEqual({
      initialDelaySeconds: 60,
      leaseSeconds: 120,
      maxAttempts: 3,
      intakeGraceSeconds: 300,
    });
    expect(
      loadTimingConfig({
        TRIAGE_INITIAL_DELAY_SECONDS: "2",
        TRIAGE_LEASE_SECONDS: "0",
        TRIAGE_MAX_ATTEMPTS: "bad",
        TRIAGE_INTAKE_GRACE_SECONDS: "9",
      }),
    ).toEqual({
      initialDelaySeconds: 2,
      leaseSeconds: 1,
      maxAttempts: 3,
      intakeGraceSeconds: 9,
    });
  });

  test("adapter queue names follow one convention", () => {
    expect(adapterQueueName("linear")).toBe("pw-support-adapter-linear");
    expect(adapterDlqName("linear")).toBe("pw-support-adapter-linear-dlq");
  });
});
