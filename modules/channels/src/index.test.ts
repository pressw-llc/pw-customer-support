import { expect, test } from "bun:test";
import { moduleInfoSchema } from "@pw-support/contracts";
import { channelAdapters } from "./index";

test("describes the channels module", () => {
  expect(moduleInfoSchema.parse(channelAdapters).name).toBe("channels");
});
