import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  resolveStackEnv,
  resourceNames,
  stageFromEnv,
  TRIAGE_WAKE_MAX_RECEIVES,
  TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
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
  const names = resourceNames(stageFromEnv(env));
  return {
    endpoint: resolveStackEnv(env).awsEndpointUrl,
    region: env.AWS_REGION ?? "us-east-1",
    bucket: env.ATTACHMENTS_BUCKET ?? names.attachmentsBucket,
    wakeQueue: env.TRIAGE_WAKE_QUEUE ?? names.triageWakeQueue,
    wakeDlq: env.TRIAGE_WAKE_DLQ ?? names.triageWakeDlq,
    linearAdapterQueue: names.linearAdapterQueue,
    linearAdapterDlq: names.linearAdapterDlq,
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
  await ensureQueueWithDlq(
    sqs,
    config.wakeQueue,
    config.wakeDlq,
    TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
  );
  await ensureQueueWithDlq(
    sqs,
    config.linearAdapterQueue,
    config.linearAdapterDlq,
    LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  );
  s3.destroy();
  sqs.destroy();
}

async function ensureQueue(
  sqs: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  let url: string | undefined;
  try {
    url = (
      await sqs.send(
        new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
      )
    ).QueueUrl;
  } catch {
    url = (await sqs.send(new GetQueueUrlCommand({ QueueName: name })))
      .QueueUrl;
  }
  await sqs.send(
    new SetQueueAttributesCommand({ QueueUrl: url, Attributes: attributes }),
  );
  return url as string;
}

async function ensureQueueWithDlq(
  sqs: SQSClient,
  queue: string,
  dlq: string,
  visibilityTimeoutSeconds: number,
): Promise<void> {
  const dlqUrl = await ensureQueue(sqs, dlq, {});
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ["QueueArn"],
    }),
  );
  await ensureQueue(sqs, queue, {
    VisibilityTimeout: String(visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: attributes.Attributes?.QueueArn,
      maxReceiveCount: TRIAGE_WAKE_MAX_RECEIVES,
    }),
  });
}

if (import.meta.main) {
  const config = stackConfig();
  await setupStack(config);
  console.log(
    `[stack-setup] bucket ${config.bucket}, queues ${config.wakeQueue}, ${config.linearAdapterQueue}, and their dead-letter queues ready`,
  );
}
