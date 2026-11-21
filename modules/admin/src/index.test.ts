import { expect, test } from "bun:test";
import { moduleInfoSchema } from "@pw-support/contracts";
import { adminApp } from "./index";

test("describes the admin module", () => {
  expect(moduleInfoSchema.parse(adminApp).name).toBe("admin");
});
