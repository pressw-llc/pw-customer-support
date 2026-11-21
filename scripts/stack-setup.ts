import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  RESOURCE_NAMES,
  resolveStackEnv,
  TRIAGE_WAKE_MAX_RECEIVES,
} from "@pw-support/contracts";

export interface StackConfig {
  endpoint: string;
  region: string;
  bucket: string;
  wakeQueue: string;
  wakeDlq: string;
  linearAdapterQueue: string;
  linearAdapterDlq: string;
}

export function stackConfig(env: NodeJS.ProcessEnv = process.env): StackConfig {
  return {
    endpoint: resolveStackEnv(env).awsEndpointUrl,
    region: env.AWS_REGION ?? "us-east-1",
    bucket: env.ATTACHMENTS_BUCKET ?? RESOURCE_NAMES.attachmentsBucket,
    wakeQueue: env.TRIAGE_WAKE_QUEUE ?? RESOURCE_NAMES.triageWakeQueue,
    wakeDlq: env.TRIAGE_WAKE_DLQ ?? RESOURCE_NAMES.triageWakeDlq,
    linearAdapterQueue: RESOURCE_NAMES.linearAdapterQueue,
    linearAdapterDlq: RESOURCE_NAMES.linearAdapterDlq,
  };
}

function clientConfig(config: StackConfig) {
  return {
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  };
}

async function ensureBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function setupStack(config: StackConfig): Promise<void> {
  const s3 = new S3Client({ ...clientConfig(config), forcePathStyle: true });
  const sqs = new SQSClient(clientConfig(config));
  await ensureBucket(s3, config.bucket);
  await ensureQueueWithDlq(sqs, config.wakeQueue, config.wakeDlq);
  await ensureQueueWithDlq(
    sqs,
    config.linearAdapterQueue,
    config.linearAdapterDlq,
  );
  s3.destroy();
  sqs.destroy();
}

async function ensureQueueWithDlq(
  sqs: SQSClient,
  queue: string,
  dlq: string,
): Promise<void> {
  const created = await sqs.send(new CreateQueueCommand({ QueueName: dlq }));
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: created.QueueUrl,
      AttributeNames: ["QueueArn"],
    }),
  );
  await sqs.send(
    new CreateQueueCommand({
      QueueName: queue,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attributes.Attributes?.QueueArn,
          maxReceiveCount: TRIAGE_WAKE_MAX_RECEIVES,
        }),
      },
    }),
  );
}

if (import.meta.main) {
  const config = stackConfig();
  await setupStack(config);
  console.log(
    `[stack-setup] bucket ${config.bucket}, queues ${config.wakeQueue}, ${config.linearAdapterQueue}, and their dead-letter queues ready`,
  );
}
