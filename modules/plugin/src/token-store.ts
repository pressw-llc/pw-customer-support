import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const storedTokensSchema = z.object({
  issuer: z.string(),
  clientId: z.string(),
  grant: z.enum(["authorization_code", "client_credentials"]),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number(),
});
export type StoredTokens = z.infer<typeof storedTokensSchema>;

export interface TokenStore {
  read(): StoredTokens | null;
  write(tokens: StoredTokens): void;
  clear(): void;
}

export const TOKEN_FILE = "tokens.json";

export function createFileTokenStore(configDir: string): TokenStore {
  const path = join(configDir, TOKEN_FILE);
  return {
    read() {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        return null;
      }
      try {
        const parsed = storedTokensSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    write(tokens) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(tokens), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}
