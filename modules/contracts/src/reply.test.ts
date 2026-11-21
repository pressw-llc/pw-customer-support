import { describe, expect, test } from "bun:test";
import {
  bandForScore,
  replyHoldReasonSchema,
  WORDING_FLAG_BELOW,
  WORDING_HOLD_BELOW,
} from "./reply";

describe("bandForScore", () => {
  test("holds below 2, flags from 2 to below 3, and sends from 3", () => {
    expect(bandForScore(0)).toBe("hold");
    expect(bandForScore(1.99)).toBe("hold");
    expect(bandForScore(WORDING_HOLD_BELOW)).toBe("send_flag");
    expect(bandForScore(2.5)).toBe("send_flag");
    expect(bandForScore(2.999)).toBe("send_flag");
    expect(bandForScore(WORDING_FLAG_BELOW)).toBe("send");
    expect(bandForScore(5)).toBe("send");
  });

  test("holds a score that is not a finite number", () => {
    expect(bandForScore(Number.NaN)).toBe("hold");
    expect(bandForScore(Number.POSITIVE_INFINITY)).toBe("hold");
  });

  test("lists the hold reasons", () => {
    expect(replyHoldReasonSchema.options).toEqual([
      "wording_low",
      "wording_unavailable",
      "too_long",
    ]);
  });
});
