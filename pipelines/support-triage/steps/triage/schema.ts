import { wakeInputSchema } from "@pw-support/contracts";
import { z } from "zod";

export const TriageInput = wakeInputSchema;

export const TriageOutput = z.object({
  action: z.enum(["dropped", "deferred", "lost", "processed"]),
});
