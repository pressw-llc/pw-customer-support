export const DEFAULT_POSTGRES_PORT = "5447";
export const DEFAULT_LOCALSTACK_PORT = "4577";
export const DEFAULT_OIDC_PORT = "4599";
export const DEFAULT_ADMIN_DEV_PORT = "5183";
export const LOCAL_OIDC_ISSUER_ID = "support";
export const LOCAL_OIDC_CLIENT_ID = "pw-support-admin";
export const LOCAL_MCP_CLIENT_ID = "pw-support-mcp";

export interface StackEnv {
  postgresPort: string;
  localstackPort: string;
  oidcPort: string;
  localIssuer: string;
  databaseUrl: string;
  awsEndpointUrl: string;
}

type EnvLike = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function databaseUrlFromParts(env: EnvLike): string | undefined {
  const host = nonEmpty(env.DB_HOST);
  const user = nonEmpty(env.DB_USER);
  const password = nonEmpty(env.DB_PASSWORD);
  if (!host || !user || !password) return undefined;
  const port = nonEmpty(env.DB_PORT) ?? "5432";
  const name = nonEmpty(env.DB_NAME) ?? "support";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}?sslmode=require`;
}

export function resolveStackEnv(env: EnvLike = process.env): StackEnv {
  const postgresPort =
    nonEmpty(env.SUPPORT_POSTGRES_PORT) ?? DEFAULT_POSTGRES_PORT;
  const localstackPort =
    nonEmpty(env.SUPPORT_LOCALSTACK_PORT) ?? DEFAULT_LOCALSTACK_PORT;
  const oidcPort = nonEmpty(env.SUPPORT_OIDC_PORT) ?? DEFAULT_OIDC_PORT;
  return {
    postgresPort,
    localstackPort,
    oidcPort,
    localIssuer: `http://127.0.0.1:${oidcPort}/${LOCAL_OIDC_ISSUER_ID}`,
    databaseUrl:
      nonEmpty(env.DATABASE_URL) ??
      databaseUrlFromParts(env) ??
      `postgres://support:support@127.0.0.1:${postgresPort}/support`,
    awsEndpointUrl:
      nonEmpty(env.AWS_ENDPOINT_URL) ?? `http://127.0.0.1:${localstackPort}`,
  };
}
