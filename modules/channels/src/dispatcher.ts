import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type {
  AdapterContext,
  AdapterMessage,
  ChannelAdapter,
  EventEnvelope,
} from "@pw-support/contracts";
import {
  advanceEventCursor,
  getEventCursor,
  maxEventSeq,
  readEventsAfter,
  type SupportDb,
} from "@pw-support/db";

export interface AdapterTransport {
  deliver(adapter: ChannelAdapter, event: EventEnvelope): Promise<void>;
}

export function directTransport(
  ctx: AdapterContext = { now: () => new Date() },
): AdapterTransport {
  return {
    deliver: (adapter, event) => adapter.handle(event, ctx),
  };
}

export function sqsTransport(options: {
  client: SQSClient;
  queueUrlFor: (adapterName: string) => Promise<string>;
}): AdapterTransport {
  return {
    async deliver(adapter, event) {
      const message: AdapterMessage = {
        pipelineRunId: crypto.randomUUID(),
        stepName: "deliver",
        input: { adapter: adapter.name, eventId: event.id, seq: event.seq },
      };
      await options.client.send(
        new SendMessageCommand({
          QueueUrl: await options.queueUrlFor(adapter.name),
          MessageBody: JSON.stringify(message),
        }),
      );
    },
  };
}

export interface DispatcherOptions {
  db: SupportDb;
  adapters: ChannelAdapter[];
  transport: AdapterTransport;
  batchSize?: number;
  startAt?: "beginning" | "latest";
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface TickResult {
  delivered: Record<string, number>;
  failed: Record<string, string>;
}

export function createDispatcher(options: DispatcherOptions) {
  const { db, adapters, transport } = options;
  const log = options.log ?? (() => {});

  async function ensureCursor(adapter: ChannelAdapter): Promise<number> {
    const current = await getEventCursor(db, adapter.name);
    if (current > 0 || options.startAt !== "latest") return current;
    const latest = await maxEventSeq(db);
    await advanceEventCursor(db, adapter.name, latest);
    return latest;
  }

  async function tick(): Promise<TickResult> {
    const result: TickResult = { delivered: {}, failed: {} };
    for (const adapter of adapters) {
      result.delivered[adapter.name] = 0;
      try {
        const cursor = await ensureCursor(adapter);
        const pending = await readEventsAfter(db, {
          afterSeq: cursor,
          types: adapter.subscribes,
          limit: options.batchSize ?? 100,
        });
        for (const event of pending) {
          await transport.deliver(adapter, event);
          await advanceEventCursor(db, adapter.name, event.seq);
          result.delivered[adapter.name] =
            (result.delivered[adapter.name] ?? 0) + 1;
        }
        for (const event of (await adapter.redeliver?.()) ?? []) {
          await transport.deliver(adapter, event);
          result.delivered[adapter.name] =
            (result.delivered[adapter.name] ?? 0) + 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failed[adapter.name] = message;
        log("adapter delivery failed", {
          adapter: adapter.name,
          error: message,
        });
      }
    }
    return result;
  }

  function run(intervalMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let running = false;
      const loop = async () => {
        if (running) return;
        running = true;
        try {
          await tick();
        } finally {
          running = false;
        }
      };
      void loop();
      const timer = setInterval(loop, intervalMs);
      signal.addEventListener("abort", () => {
        clearInterval(timer);
        resolve();
      });
    });
  }

  return { tick, run };
}
