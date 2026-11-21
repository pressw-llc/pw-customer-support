import { afterAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { wakeMessageSchema } from "@pw-support/contracts";
import {
  clampDelay,
  createSqsClient,
  createSqsWakeSender,
  resolveQueueUrl,
} from "./wake";

const client = createSqsClient({});
const queueName = `pw-support-test-wake-${crypto.randomUUID().slice(0, 8)}`;
const created = await client.send(
  new CreateQueueCommand({ QueueName: queueName }),
);

afterAll(async () => {
  await client.send(new DeleteQueueCommand({ QueueUrl: created.QueueUrl }));
  client.destroy();
});

describe("wake sender", () => {
  test("clampDelay stays between 0 and 900 seconds", () => {
    expect(clampDelay(-5)).toBe(0);
    expect(clampDelay(7.9)).toBe(7);
    expect(clampDelay(5000)).toBe(900);
  });

  test("resolves the queue url by name", async () => {
    expect(await resolveQueueUrl(client, queueName)).toBe(
      created.QueueUrl as string,
    );
  });

  test("sends the pipeline message with DelaySeconds so the message stays hidden until the delay ends", async () => {
    const sender = createSqsWakeSender({ client, queueName });
    const jobId = crypto.randomUUID();
    await sender.send(jobId, 2);
    const early = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: created.QueueUrl,
        WaitTimeSeconds: 0,
      }),
    );
    expect(early.Messages ?? []).toHaveLength(0);
    const late = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: created.QueueUrl,
        WaitTimeSeconds: 5,
      }),
    );
    const body = wakeMessageSchema.parse(
      JSON.parse(late.Messages?.[0]?.Body ?? "{}"),
    );
    expect(body.input.jobId).toBe(jobId);
    expect(body.stepName).toBe("triage");
  });

  test("a missing queue is an error", async () => {
    await expect(
      resolveQueueUrl(client, "pw-support-no-such-queue"),
    ).rejects.toThrow();
  });
});
