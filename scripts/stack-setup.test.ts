import { expect, test } from "bun:test";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
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
  expect(wake.QueueUrl).toContain(config.wakeQueue);
  expect(dlq.QueueUrl).toContain(config.wakeDlq);
  s3.destroy();
  sqs.destroy();
});
