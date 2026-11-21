import { ATTACHMENT_LIMITS, RESOURCE_NAMES } from "@pw-support/contracts";

export interface ApiConfig {
  port: number;
  bucket: string;
  maxBodyBytes: number;
  rateLimit: {
    windowSeconds: number;
    perKey: number;
    perUser: number;
  };
  s3: {
    region: string;
    endpoint: string | undefined;
    credentials: { accessKeyId: string; secretAccessKey: string } | undefined;
  };
}

const DEFAULT_PORT = 8787;
const DEFAULT_LOCALSTACK_PORT = "4577";
const BODY_OVERHEAD_BYTES = 1024 * 1024;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const local = env.NODE_ENV !== "production";
  const localEndpoint = `http://127.0.0.1:${env.SUPPORT_LOCALSTACK_PORT ?? DEFAULT_LOCALSTACK_PORT}`;
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? (local ? "test" : undefined);
  const secretAccessKey =
    env.AWS_SECRET_ACCESS_KEY ?? (local ? "test" : undefined);
  return {
    port: positiveInt(env.API_PORT, DEFAULT_PORT),
    bucket: env.ATTACHMENTS_BUCKET ?? RESOURCE_NAMES.attachmentsBucket,
    maxBodyBytes: positiveInt(
      env.MAX_REQUEST_BYTES,
      ATTACHMENT_LIMITS.maxFiles * ATTACHMENT_LIMITS.maxBytes +
        BODY_OVERHEAD_BYTES,
    ),
    rateLimit: {
      windowSeconds: positiveInt(env.RATE_LIMIT_WINDOW_SECONDS, 60),
      perKey: positiveInt(env.RATE_LIMIT_PER_KEY, 600),
      perUser: positiveInt(env.RATE_LIMIT_PER_USER, 120),
    },
    s3: {
      region: env.AWS_REGION ?? "us-east-1",
      endpoint: env.AWS_ENDPOINT_URL ?? (local ? localEndpoint : undefined),
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
    },
  };
}
