import { expect, test } from "bun:test";
import { moduleInfoSchema } from "@pw-support/contracts";
import { supportWidget } from "./index";

test("describes the widget module", () => {
  expect(moduleInfoSchema.parse(supportWidget).name).toBe("widget");
});
