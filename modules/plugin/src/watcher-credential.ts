import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { watcherRegistrationSchema } from "@pw-support/contracts";

export type WatcherCredential = { machineId: string; secret: string };

export const WATCHER_CREDENTIAL_FILE = "watcher-credential.json";

export interface WatcherCredentialStore {
  read(): WatcherCredential | null;
  ensure(): WatcherCredential;
  clear(): void;
}

export function createWatcherCredentialStore(
  configDir: string,
): WatcherCredentialStore {
  const path = join(configDir, WATCHER_CREDENTIAL_FILE);

  function read(): WatcherCredential | null {
    try {
      const parsed = watcherRegistrationSchema.safeParse(
        JSON.parse(readFileSync(path, "utf8")),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  return {
    read,
    ensure() {
      const existing = read();
      if (existing) return existing;
      const created = {
        machineId: randomUUID(),
        secret: randomBytes(32).toString("base64url"),
      };
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(created), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
      return created;
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}
