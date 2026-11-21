import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  buildWakeMessage,
  resolveStackEnv,
  TRIAGE_DEFAULTS,
  type WakeSender,
} from "@pw-support/contracts";

type EnvLike = Record<string, string | undefined>;

export function createSqsClient(env: EnvLike = process.env): SQSClient {
  const local = env.NODE_ENV !== "production";
  const endpoint = local
    ? resolveStackEnv(env).awsEndpointUrl
    : env.AWS_ENDPOINT_URL;
  return new SQSClient({
    region: env.AWS_REGION || "us-east-1",
    endpoint,
    credentials: local
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID || "test",
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY || "test",
        }
      : undefined,
  });
}

export async function resolveQueueUrl(
  client: SQSClient,
  queueName: string,
): Promise<string> {
  const result = await client.send(
    new GetQueueUrlCommand({ QueueName: queueName }),
  );
  if (!result.QueueUrl) throw new Error(`queue ${queueName} has no url`);
  return result.QueueUrl;
}

export function clampDelay(seconds: number): number {
  return Math.min(
    TRIAGE_DEFAULTS.maxWakeDelaySeconds,
    Math.max(0, Math.floor(seconds)),
  );
}

export function createSqsWakeSender(options: {
  client: SQSClient;
  queueName: string;
}): WakeSender {
  let url: Promise<string> | undefined;
  return {
    async send(jobId, delaySeconds) {
      url ??= resolveQueueUrl(options.client, options.queueName);
      await options.client.send(
        new SendMessageCommand({
          QueueUrl: await url,
          MessageBody: JSON.stringify(buildWakeMessage(jobId)),
          DelaySeconds: clampDelay(delaySeconds),
        }),
      );
    },
  };
}
