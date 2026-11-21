import {
  type EventEnvelope,
  type EventInput,
  eventEnvelopeSchema,
  eventInputSchema,
} from "@pw-support/contracts";
import type { SupportExecutor } from "./client";
import { events } from "./schema";

export async function appendEvent(
  tx: SupportExecutor,
  event: EventInput,
): Promise<EventEnvelope> {
  const parsed = eventInputSchema.parse(event);
  const [row] = await tx
    .insert(events)
    .values({
      type: parsed.type,
      channelKey: parsed.channelKey,
      requestId: parsed.requestId ?? null,
      payload: parsed.payload,
    })
    .returning();
  return eventEnvelopeSchema.parse(row);
}
