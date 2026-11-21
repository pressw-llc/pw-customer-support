import { describe, expect, test } from "bun:test";
import {
  TRIAGE_LIMITS,
  triageCategories,
  triageLabels,
  triagePriorities,
  triageResultSchema,
} from "./triage-result";

const valid = {
  title: "Export fails with a timeout",
  summary:
    "The customer reports that the CSV export times out after 30 seconds.",
  category: "bug",
  priority: "high",
  labels: ["bug", "performance"],
  needs_human: false,
};

describe("triageResultSchema", () => {
  test("accepts a complete result", () => {
    expect(triageResultSchema.parse(valid)).toMatchObject(valid);
  });

  test("accepts every priority and category", () => {
    for (const priority of triagePriorities) {
      expect(triageResultSchema.safeParse({ ...valid, priority }).success).toBe(
        true,
      );
    }
    for (const category of triageCategories) {
      expect(triageResultSchema.safeParse({ ...valid, category }).success).toBe(
        true,
      );
    }
  });

  test("accepts an empty label list", () => {
    expect(triageResultSchema.safeParse({ ...valid, labels: [] }).success).toBe(
      true,
    );
  });

  test("bounds the title", () => {
    const edge = "t".repeat(TRIAGE_LIMITS.titleMax);
    expect(
      triageResultSchema.safeParse({ ...valid, title: edge }).success,
    ).toBe(true);
    expect(
      triageResultSchema.safeParse({ ...valid, title: `${edge}t` }).success,
    ).toBe(false);
    expect(
      triageResultSchema.safeParse({ ...valid, title: "  " }).success,
    ).toBe(false);
  });

  test("bounds the summary", () => {
    const edge = "s".repeat(TRIAGE_LIMITS.summaryMax);
    expect(
      triageResultSchema.safeParse({ ...valid, summary: edge }).success,
    ).toBe(true);
    expect(
      triageResultSchema.safeParse({ ...valid, summary: `${edge}s` }).success,
    ).toBe(false);
  });

  test("rejects values outside the enums", () => {
    expect(
      triageResultSchema.safeParse({ ...valid, category: "refund" }).success,
    ).toBe(false);
    expect(
      triageResultSchema.safeParse({ ...valid, priority: "critical" }).success,
    ).toBe(false);
    expect(
      triageResultSchema.safeParse({ ...valid, labels: ["unknown"] }).success,
    ).toBe(false);
  });

  test("allows at most five unique labels", () => {
    const five = triageLabels.slice(0, 5);
    expect(
      triageResultSchema.safeParse({ ...valid, labels: five }).success,
    ).toBe(true);
    expect(
      triageResultSchema.safeParse({
        ...valid,
        labels: triageLabels.slice(0, 6),
      }).success,
    ).toBe(false);
    expect(
      triageResultSchema.safeParse({ ...valid, labels: ["bug", "bug"] })
        .success,
    ).toBe(false);
  });

  test("requires a boolean needs_human", () => {
    expect(
      triageResultSchema.safeParse({ ...valid, needs_human: "yes" }).success,
    ).toBe(false);
  });

  test("rejects extra and missing fields", () => {
    expect(
      triageResultSchema.safeParse({ ...valid, assignee: "someone" }).success,
    ).toBe(false);
    const { title: _title, ...missing } = valid;
    expect(triageResultSchema.safeParse(missing).success).toBe(false);
  });
});
