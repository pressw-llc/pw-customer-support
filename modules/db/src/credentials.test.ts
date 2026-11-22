import { describe, expect, test } from "bun:test";
import {
  createCredentialsProvider,
  isAuthError,
  parseCredentials,
  secretsManagerFetcher,
} from "./credentials";

const secret = (password: string) =>
  JSON.stringify({ username: "support", password });

function counting(passwords: string[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetchSecret: async () => {
      const value = passwords[Math.min(calls, passwords.length - 1)] as string;
      calls += 1;
      await Bun.sleep(5);
      return secret(value);
    },
  };
}

describe("createCredentialsProvider", () => {
  test("caches the secret until the ttl passes", async () => {
    const source = counting(["p1", "p2"]);
    let clock = 0;
    const provider = createCredentialsProvider({
      fetchSecret: source.fetchSecret,
      ttlMs: 1_000,
      now: () => clock,
    });
    expect((await provider.get()).password).toBe("p1");
    clock = 999;
    expect((await provider.get()).password).toBe("p1");
    expect(source.calls).toBe(1);
    clock = 1_000;
    expect((await provider.get()).password).toBe("p2");
    expect(source.calls).toBe(2);
  });

  test("concurrent callers share one fetch", async () => {
    const source = counting(["p1"]);
    const provider = createCredentialsProvider({
      fetchSecret: source.fetchSecret,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => provider.get()),
    );
    expect(new Set(results.map((value) => value.password))).toEqual(
      new Set(["p1"]),
    );
    expect(source.calls).toBe(1);
  });

  test("invalidate forces the next call to fetch the rotated password", async () => {
    const source = counting(["old", "rotated"]);
    const provider = createCredentialsProvider({
      fetchSecret: source.fetchSecret,
    });
    expect((await provider.get()).password).toBe("old");
    provider.invalidate();
    expect((await provider.get()).password).toBe("rotated");
  });

  test("a close after an attempt that never authenticated invalidates the cache", async () => {
    const source = counting(["old", "rotated"]);
    const provider = createCredentialsProvider({
      fetchSecret: source.fetchSecret,
    });
    provider.noteAttempt();
    await provider.get();
    provider.noteClosed();
    expect((await provider.get()).password).toBe("rotated");
  });

  test("an attempt that follows one that never authenticated refetches the secret", async () => {
    const source = counting(["old", "rotated"]);
    let clock = 0;
    const provider = createCredentialsProvider({
      fetchSecret: source.fetchSecret,
      now: () => clock,
    });
    provider.noteAttempt();
    expect((await provider.get()).password).toBe("old");
    clock = 100;
    provider.noteAttempt();
    expect((await provider.get()).password).toBe("old");
    clock = 600;
    provider.noteAttempt();
    expect((await provider.get()).password).toBe("rotated");
    expect(source.calls).toBe(2);
  });

  test("a close after an authenticated connection keeps the cache", async () => {
    const source = counting(["old", "rotated"]);
    const provider = createCredentialsProvider({
      fetchSecret: source.fetchSecret,
    });
    provider.noteAttempt();
    await provider.get();
    provider.noteAuthenticated();
    provider.noteClosed();
    expect((await provider.get()).password).toBe("old");
  });

  test("a failed fetch is not cached and the next caller retries", async () => {
    let calls = 0;
    const provider = createCredentialsProvider({
      fetchSecret: async () => {
        calls += 1;
        if (calls === 1) throw new Error("secrets manager down");
        return secret("ok");
      },
    });
    await expect(provider.get()).rejects.toThrow("secrets manager down");
    expect((await provider.get()).password).toBe("ok");
  });
});

describe("helpers", () => {
  test("recognizes authentication SQLSTATEs only", () => {
    expect(isAuthError({ code: "28P01" })).toBe(true);
    expect(isAuthError({ code: "28000" })).toBe(true);
    expect(isAuthError({ code: "42P01" })).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });

  test("rejects an empty secret or one without credentials", () => {
    expect(() => parseCredentials(undefined)).toThrow("empty");
    expect(() => parseCredentials("{}")).toThrow("no credentials");
    expect(parseCredentials(secret("x"))).toEqual({
      username: "support",
      password: "x",
    });
  });

  test("the fetcher reads the secret string by id", async () => {
    const seen: unknown[] = [];
    const fetcher = secretsManagerFetcher("arn:secret", {
      send: async (command: { input: unknown }) => {
        seen.push(command.input);
        return { SecretString: "value" };
      },
    } as never);
    expect(await fetcher()).toBe("value");
    expect(seen).toEqual([{ SecretId: "arn:secret" }]);
  });
});
