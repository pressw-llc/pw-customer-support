import { z } from "zod";

export const moduleInfoSchema = z.object({
  name: z.string().min(1),
  owns: z.array(z.string().min(1)).min(1),
});
export type ModuleInfo = z.infer<typeof moduleInfoSchema>;
