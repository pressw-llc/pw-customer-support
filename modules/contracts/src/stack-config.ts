export const DEFAULT_POSTGRES_PORT = "5447";
export const DEFAULT_LOCALSTACK_PORT = "4577";

export interface StackEnv {
  postgresPort: string;
  localstackPort: string;
  databaseUrl: string;
  awsEndpointUrl: string;
}

type EnvLike = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function resolveStackEnv(env: EnvLike = process.env): StackEnv {
  const postgresPort =
    nonEmpty(env.SUPPORT_POSTGRES_PORT) ?? DEFAULT_POSTGRES_PORT;
  const localstackPort =
    nonEmpty(env.SUPPORT_LOCALSTACK_PORT) ?? DEFAULT_LOCALSTACK_PORT;
  return {
    postgresPort,
    localstackPort,
    databaseUrl:
      nonEmpty(env.DATABASE_URL) ??
      `postgres://support:support@127.0.0.1:${postgresPort}/support`,
    awsEndpointUrl:
      nonEmpty(env.AWS_ENDPOINT_URL) ?? `http://127.0.0.1:${localstackPort}`,
  };
}
