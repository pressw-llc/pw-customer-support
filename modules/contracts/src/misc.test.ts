import { describe, expect, test } from "bun:test";
import { moduleInfoSchema } from "./module-info";
import { RESOURCE_NAMES, TRIAGE_WAKE_MAX_RECEIVES } from "./resources";

describe("moduleInfoSchema", () => {
  test("requires a name and at least one owned area", () => {
    expect(
      moduleInfoSchema.safeParse({ name: "api", owns: ["routes"] }).success,
    ).toBe(true);
    expect(moduleInfoSchema.safeParse({ name: "api", owns: [] }).success).toBe(
      false,
    );
    expect(moduleInfoSchema.safeParse({ name: "", owns: ["x"] }).success).toBe(
      false,
    );
  });
});

describe("RESOURCE_NAMES", () => {
  test("ends the secrets prefix with a slash", () => {
    expect(RESOURCE_NAMES.secretsPrefix.endsWith("/")).toBe(true);
  });

  test("names the dead-letter queue after the wake queue", () => {
    expect(RESOURCE_NAMES.triageWakeDlq).toStartWith(
      RESOURCE_NAMES.triageWakeQueue,
    );
    expect(TRIAGE_WAKE_MAX_RECEIVES).toBeGreaterThan(0);
  });
});
