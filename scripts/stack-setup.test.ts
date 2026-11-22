import { expect, test } from "bun:test";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
} from "@pw-support/contracts";
import { setupStack, stackConfig } from "./stack-setup";

test("stackConfig falls back to the local defaults", () => {
  const config = stackConfig({});
  expect(config.endpoint).toBe("http://127.0.0.1:4577");
  expect(config.region).toBe("us-east-1");
  expect(config.bucket).toBe("pw-support-attachments");
});

test("stackConfig reads the port and names from the environment", () => {
  const config = stackConfig({
    SUPPORT_LOCALSTACK_PORT: "4999",
    ATTACHMENTS_BUCKET: "other-bucket",
  });
  expect(config.endpoint).toBe("http://127.0.0.1:4999");
  expect(config.bucket).toBe("other-bucket");
});

test("setupStack creates the bucket and queues and can run twice", async () => {
  const config = stackConfig();
  await setupStack(config);
  await setupStack(config);
  const credentials = { accessKeyId: "test", secretAccessKey: "test" };
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials,
    forcePathStyle: true,
  });
  const sqs = new SQSClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials,
  });
  await s3.send(new HeadBucketCommand({ Bucket: config.bucket }));
  const wake = await sqs.send(
    new GetQueueUrlCommand({ QueueName: config.wakeQueue }),
  );
  const dlq = await sqs.send(
    new GetQueueUrlCommand({ QueueName: config.wakeDlq }),
  );
  const adapter = await sqs.send(
    new GetQueueUrlCommand({ QueueName: config.linearAdapterQueue }),
  );
  const adapterDlq = await sqs.send(
    new GetQueueUrlCommand({ QueueName: config.linearAdapterDlq }),
  );
  expect(adapter.QueueUrl).toContain(config.linearAdapterQueue);
  expect(adapterDlq.QueueUrl).toContain(config.linearAdapterDlq);
  expect(wake.QueueUrl).toContain(config.wakeQueue);
  expect(dlq.QueueUrl).toContain(config.wakeDlq);
  s3.destroy();
  sqs.destroy();
});

test("setupStack enforces the visibility timeout on queues that already exist", async () => {
  const config = stackConfig();
  const sqs = new SQSClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const timeoutOf = async (name: string) => {
    const { QueueUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: name }),
    );
    const attributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ["VisibilityTimeout"],
      }),
    );
    return Number(attributes.Attributes?.VisibilityTimeout);
  };
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: config.wakeQueue }),
  );
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl,
      Attributes: { VisibilityTimeout: "30" },
    }),
  );
  expect(await timeoutOf(config.wakeQueue)).toBe(30);
  await setupStack(config);
  expect(await timeoutOf(config.wakeQueue)).toBe(
    TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
  );
  expect(await timeoutOf(config.linearAdapterQueue)).toBe(
    LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  );
  sqs.destroy();
});
