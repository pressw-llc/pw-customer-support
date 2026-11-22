type EnvLike = Record<string, string | undefined>;

export type SecretFetcher = (secretId: string) => Promise<string | undefined>;

interface DbSecret {
  username?: string;
  password?: string;
  host?: string;
  port?: number | string;
  dbname?: string;
}

export async function hydrateDatabaseEnv(
  env: EnvLike,
  fetchSecret: SecretFetcher,
): Promise<void> {
  const secretId = env.DB_SECRET_ARN;
  if (!secretId || env.DB_PASSWORD) return;
  const raw = await fetchSecret(secretId);
  if (!raw) throw new Error("database secret is empty");
  const secret = JSON.parse(raw) as DbSecret;
  if (!secret.username || !secret.password) {
    throw new Error("database secret has no credentials");
  }
  env.DB_USER = secret.username;
  env.DB_PASSWORD = secret.password;
  env.DB_HOST ||= secret.host;
  env.DB_PORT ||= secret.port === undefined ? undefined : String(secret.port);
  env.DB_NAME ||= secret.dbname;
}
