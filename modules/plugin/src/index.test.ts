import { expect, test } from "bun:test";
import { moduleInfoSchema } from "@pw-support/contracts";
import { laptopPlugin } from "./index";

test("describes the plugin module", () => {
  expect(moduleInfoSchema.parse(laptopPlugin).name).toBe("plugin");
});
