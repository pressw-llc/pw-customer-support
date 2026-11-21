import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";

export interface SqsRecord {
  messageId: string;
  body: string;
}

export type SqsBatchHandler = (event: {
  Records: SqsRecord[];
}) => Promise<{ batchItemFailures: { itemIdentifier: string }[] } | undefined>;

export interface PollerOptions {
  client: SQSClient;
  queueUrl: string;
  handler: SqsBatchHandler;
  signal: AbortSignal;
  waitSeconds?: number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export async function pollOnce(
  options: PollerOptions,
  waitSeconds = options.waitSeconds ?? 5,
): Promise<number> {
  const received = await options.client.send(
    new ReceiveMessageCommand({
      QueueUrl: options.queueUrl,
      MaxNumberOfMessages: 5,
      WaitTimeSeconds: waitSeconds,
    }),
  );
  const messages = received.Messages ?? [];
  if (messages.length === 0) return 0;
  const result = await options.handler({
    Records: messages.map((message) => ({
      messageId: message.MessageId ?? "",
      body: message.Body ?? "",
    })),
  });
  const failed = new Set(
    (result?.batchItemFailures ?? []).map((item) => item.itemIdentifier),
  );
  for (const message of messages) {
    if (failed.has(message.MessageId ?? "")) continue;
    await options.client.send(
      new DeleteMessageCommand({
        QueueUrl: options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }
  return messages.length;
}

export async function runPoller(options: PollerOptions): Promise<void> {
  while (!options.signal.aborted) {
    try {
      await pollOnce(options);
    } catch (error) {
      options.log?.("poller error", {
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
