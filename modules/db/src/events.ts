import {
  type EventEnvelope,
  type EventInput,
  eventEnvelopeSchema,
  eventInputSchema,
} from "@pw-support/contracts";
import { sql } from "drizzle-orm";
import type { SupportDb, SupportExecutor } from "./client";
import { events } from "./schema";

const EVENT_APPEND_LOCK_ID = 7_340_001;

type SupportTx = Parameters<Parameters<SupportDb["transaction"]>[0]>[0];

function isTransaction(executor: SupportExecutor): executor is SupportTx {
  return "rollback" in executor;
}

async function insertEvent(
  tx: SupportTx,
  event: EventInput,
): Promise<EventEnvelope> {
  await tx.execute(sql`select pg_advisory_xact_lock(${EVENT_APPEND_LOCK_ID})`);
  const [row] = await tx
    .insert(events)
    .values({
      type: event.type,
      channelKey: event.channelKey,
      requestId: event.requestId ?? null,
      payload: event.payload,
    })
    .returning();
  return eventEnvelopeSchema.parse(row);
}

export async function appendEvent(
  executor: SupportExecutor,
  event: EventInput,
): Promise<EventEnvelope> {
  const parsed = eventInputSchema.parse(event);
  if (isTransaction(executor)) return insertEvent(executor, parsed);
  return executor.transaction((tx) => insertEvent(tx, parsed));
}
