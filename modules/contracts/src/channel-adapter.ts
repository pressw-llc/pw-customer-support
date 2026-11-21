import { z } from "zod";
import type { EventEnvelope, EventType } from "./events";

export interface AdapterContext {
  now: () => Date;
}

export interface ChannelAdapter {
  name: string;
  subscribes: readonly EventType[];
  handle(event: EventEnvelope, ctx: AdapterContext): Promise<void>;
}

export const ADAPTER_QUEUE_PREFIX = "pw-support-adapter-";

export function adapterQueueName(adapter: string): string {
  return `${ADAPTER_QUEUE_PREFIX}${adapter}`;
}

export function adapterDlqName(adapter: string): string {
  return `${ADAPTER_QUEUE_PREFIX}${adapter}-dlq`;
}

export const adapterMessageSchema = z.object({
  pipelineRunId: z.string().uuid(),
  stepName: z.literal("deliver"),
  input: z.object({
    adapter: z.string().min(1),
    eventId: z.string().uuid(),
    seq: z.number().int().positive(),
  }),
});
export type AdapterMessage = z.infer<typeof adapterMessageSchema>;
