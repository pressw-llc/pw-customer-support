import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

export interface DbCredentials {
  username: string;
  password: string;
}

export const DEFAULT_CREDENTIALS_TTL_MS = 5 * 60_000;
export const MIN_REFRESH_AFTER_FAILURE_MS = 500;

export interface CredentialsProvider {
  get(): Promise<DbCredentials>;
  invalidate(): void;
  noteAttempt(): void;
  noteAuthenticated(): void;
  noteClosed(): void;
}

export function parseCredentials(raw: string | undefined): DbCredentials {
  if (!raw) throw new Error("database secret is empty");
  const parsed = JSON.parse(raw) as { username?: string; password?: string };
  if (!parsed.username || !parsed.password) {
    throw new Error("database secret has no credentials");
  }
  return { username: parsed.username, password: parsed.password };
}

export function isAuthError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "28P01" || code === "28000";
}

export function createCredentialsProvider(options: {
  fetchSecret: () => Promise<string | undefined>;
  ttlMs?: number;
  now?: () => number;
}): CredentialsProvider {
  const ttl = options.ttlMs ?? DEFAULT_CREDENTIALS_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { value: DbCredentials; at: number } | undefined;
  let inflight: Promise<DbCredentials> | undefined;
  let lastAttempt = 0;
  let lastAuthenticated = 0;
  let tick = 0;

  const load = async (): Promise<DbCredentials> => {
    try {
      const value = parseCredentials(await options.fetchSecret());
      cached = { value, at: now() };
      return value;
    } finally {
      inflight = undefined;
    }
  };

  return {
    async get() {
      if (cached && now() - cached.at < ttl) return cached.value;
      inflight ??= load();
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
    noteAttempt() {
      const failedBefore = lastAttempt > lastAuthenticated;
      if (
        failedBefore &&
        cached &&
        now() - cached.at >= MIN_REFRESH_AFTER_FAILURE_MS
      ) {
        cached = undefined;
      }
      lastAttempt = ++tick;
    },
    noteAuthenticated() {
      lastAuthenticated = ++tick;
    },
    noteClosed() {
      if (lastAttempt > lastAuthenticated) cached = undefined;
    },
  };
}

export function secretsManagerFetcher(
  secretId: string,
  client: Pick<SecretsManagerClient, "send"> = new SecretsManagerClient({}),
): () => Promise<string | undefined> {
  return async () =>
    (await client.send(new GetSecretValueCommand({ SecretId: secretId })))
      .SecretString;
}
