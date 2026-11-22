import {
  ATTACHMENT_LIMITS,
  DEFAULT_ADMIN_DEV_PORT,
  LOCAL_MCP_CLIENT_ID,
  LOCAL_OIDC_CLIENT_ID,
  RESOURCE_NAMES,
  resolveSecretsScope,
  resolveStackEnv,
} from "@pw-support/contracts";
import type { AuthConfig } from "./auth";

export interface ApiConfig {
  port: number;
  bucket: string;
  maxBodyBytes: number;
  rateLimit: {
    windowSeconds: number;
    perKey: number;
    perUser: number;
  };
  auth: AuthConfig;
  adminOrigins: string[];
  mcp: {
    audiences: string[];
    requiredGroup: string | undefined;
    perWindow: number;
    maxBodyBytes: number;
  };
  admin: {
    maxBodyBytes: number;
    mutationsPerWindow: number;
  };
  secretsScope: string;
  s3: {
    region: string;
    endpoint: string | undefined;
    credentials: { accessKeyId: string; secretAccessKey: string } | undefined;
  };
}

export function mcpAuthConfig(config: ApiConfig): AuthConfig {
  return {
    ...config.auth,
    audiences: config.mcp.audiences,
    allowedEmailDomains: [],
    requiredGroup: config.mcp.requiredGroup,
  };
}

const DEFAULT_PORT = 8787;
const BODY_OVERHEAD_BYTES = 1024 * 1024;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const local = env.NODE_ENV !== "production";
  const stack = resolveStackEnv(env);
  const adminAudiences = env.COGNITO_AUDIENCE
    ? csv(env.COGNITO_AUDIENCE)
    : local
      ? [LOCAL_OIDC_CLIENT_ID]
      : [];
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
    auth: {
      issuer: env.COGNITO_ISSUER || (local ? stack.localIssuer : undefined),
      audiences: adminAudiences,
      allowedEmailDomains: csv(env.ADMIN_ALLOWED_EMAIL_DOMAINS).map((domain) =>
        domain.toLowerCase(),
      ),
      requiredGroup: env.ADMIN_REQUIRED_GROUP || undefined,
      clockToleranceSeconds: 30,
      fetchTimeoutMs: positiveInt(env.AUTH_FETCH_TIMEOUT_MS, 5000),
    },
    adminOrigins: env.ADMIN_ORIGINS
      ? csv(env.ADMIN_ORIGINS)
      : local
        ? [
            `http://127.0.0.1:${env.ADMIN_DEV_PORT || DEFAULT_ADMIN_DEV_PORT}`,
            `http://localhost:${env.ADMIN_DEV_PORT || DEFAULT_ADMIN_DEV_PORT}`,
          ]
        : [],
    mcp: {
      audiences: env.MCP_AUDIENCE
        ? csv(env.MCP_AUDIENCE)
        : local
          ? [LOCAL_MCP_CLIENT_ID, ...adminAudiences]
          : adminAudiences,
      requiredGroup: env.MCP_REQUIRED_GROUP || undefined,
      perWindow: positiveInt(env.MCP_RATE_LIMIT_PER_WINDOW, 120),
      maxBodyBytes: positiveInt(env.MCP_MAX_BODY_BYTES, 256 * 1024),
    },
    admin: {
      maxBodyBytes: positiveInt(env.ADMIN_MAX_BODY_BYTES, 16 * 1024),
      mutationsPerWindow: positiveInt(env.ADMIN_RATE_LIMIT_PER_WINDOW, 60),
    },
    secretsScope: resolveSecretsScope(env),
    s3: {
      region: env.AWS_REGION ?? "us-east-1",
      endpoint: local ? stack.awsEndpointUrl : env.AWS_ENDPOINT_URL,
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
    },
  };
}
