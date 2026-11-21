import { expect, test } from "bun:test";
import { moduleInfoSchema } from "@pw-support/contracts";
import { triageWorker } from "./index";

test("describes the triage module", () => {
  expect(moduleInfoSchema.parse(triageWorker).name).toBe("triage");
});
