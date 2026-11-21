import { defineStep } from "@pressw-llc/pipeline/define";
import { getAdapterRuntime } from "@pw-support/channels";
import { getEventBySeq } from "@pw-support/db";
import { DeliverInput, DeliverOutput } from "./schema";

export default defineStep({
  input: DeliverInput,
  output: DeliverOutput,
  async handler(input) {
    const runtime = getAdapterRuntime();
    const event = await getEventBySeq(runtime.db, input.seq);
    if (!event || event.id !== input.eventId) {
      throw new Error(`event ${input.seq} not found`);
    }
    await runtime.linearAdapter.handle(event, { now: () => new Date() });
    return { delivered: true };
  },
});
