import { adapterMessageSchema } from "@pw-support/contracts";
import { z } from "zod";

export const DeliverInput = adapterMessageSchema.shape.input;

export const DeliverOutput = z.object({
  delivered: z.boolean(),
});
