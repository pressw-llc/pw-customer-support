import {
  ATTACHMENT_LIMITS,
  DEFAULT_ADMIN_DEV_PORT,
  LOCAL_MCP_CLIENT_ID,
  LOCAL_OIDC_CLIENT_ID,
  resolveSecretsScope,
  resolveStackEnv,
  resourceNames,
  stageFromEnv,
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
    disabled?: boolean;
  };
  admin: {
    maxBodyBytes: number;
    mutationsPerWindow: number;
    disabled?: boolean;
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

export function mcpMissingSettings(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== "production") return [];
  const missing: string[] = [];
  if (csv(env.MCP_AUDIENCE).length === 0) missing.push("MCP_AUDIENCE");
  if (!env.MCP_REQUIRED_GROUP) missing.push("MCP_REQUIRED_GROUP");
  return missing;
}

export function adminPolicyMissing(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === "production" &&
    !env.ADMIN_REQUIRED_GROUP &&
    csv(env.ADMIN_ALLOWED_EMAIL_DOMAINS).length === 0
  );
}

export function productionConfigErrors(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const errors: string[] = [];
  const missing = mcpMissingSettings(env);
  if (missing.length > 0) {
    errors.push(
      `${missing.join(" and ")} must be set in production; /mcp, /mcp/laptop, and /laptop/watcher answer 503 until they are`,
    );
  }
  if (adminPolicyMissing(env)) {
    errors.push(
      "ADMIN_REQUIRED_GROUP or ADMIN_ALLOWED_EMAIL_DOMAINS must be set in production; every /admin route answers 503 admin_not_configured until one is",
    );
  }
  return errors;
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
  const mcpDisabled = mcpMissingSettings(env).length > 0;
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? (local ? "test" : undefined);
  const secretAccessKey =
    env.AWS_SECRET_ACCESS_KEY ?? (local ? "test" : undefined);
  return {
    port: positiveInt(env.API_PORT, DEFAULT_PORT),
    bucket:
      env.ATTACHMENTS_BUCKET ??
      resourceNames(stageFromEnv(env)).attachmentsBucket,
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
          : [],
      requiredGroup: env.MCP_REQUIRED_GROUP || undefined,
      ...(mcpDisabled ? { disabled: true } : {}),
      perWindow: positiveInt(env.MCP_RATE_LIMIT_PER_WINDOW, 120),
      maxBodyBytes: positiveInt(env.MCP_MAX_BODY_BYTES, 256 * 1024),
    },
    admin: {
      maxBodyBytes: positiveInt(env.ADMIN_MAX_BODY_BYTES, 16 * 1024),
      mutationsPerWindow: positiveInt(env.ADMIN_RATE_LIMIT_PER_WINDOW, 60),
      ...(adminPolicyMissing(env) ? { disabled: true } : {}),
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
