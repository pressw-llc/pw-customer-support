import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_MCP_CLIENT_ID, resolveStackEnv } from "@pw-support/contracts";
import { decodeJwt } from "jose";
import { type CliIo, defaultIo, openInBrowser, runCli } from "./commands";
import { completeMockLogin } from "./testing/mock-login";
import { createFileTokenStore } from "./token-store";
import { createWatcherCredentialStore } from "./watcher-credential";

let dir: string;
let out: string[];
let err: string[];

function io(
  env: Record<string, string> = {},
  openUrl?: CliIo["openUrl"],
  overrides: CliIo["overrides"] = {},
): CliIo {
  return {
    overrides: { loginPort: 0, ...overrides },
    env: {
      ...process.env,
      PW_SUPPORT_CONFIG_DIR: dir,
      PW_SUPPORT_ISSUER: resolveStackEnv(process.env).localIssuer,
      ...env,
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    openUrl: openUrl ?? (() => {}),
    cliPath: "/unused/cli.ts",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pw-support-cli-"));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pw-support commands", () => {
  test("prints usage and rejects unknown commands", async () => {
    expect(await runCli([], io())).toBe(0);
    expect(await runCli(["help"], io())).toBe(0);
    expect(await runCli(["nope"], io())).toBe(2);
    expect(err[0]).toContain("usage: pw-support");
    const real = defaultIo();
    expect(real.cliPath).toContain("cli.ts");
    real.out("");
    real.err("");
    const launched: string[][] = [];
    openInBrowser("https://idp.test/authorize", ((
      command: string,
      args: string[],
    ) => {
      launched.push([command, ...args]);
      return { on: () => {}, unref: () => {} };
    }) as never);
    expect(launched[0]?.[1]).toBe("https://idp.test/authorize");
  });

  test("login with client credentials against the mock issuer, then token, headers, and logout", async () => {
    expect(await runCli(["login", "--client-credentials"], io())).toBe(1);
    expect(err.at(-1)).toContain("client secret");
    const env = { PW_SUPPORT_CLIENT_ID: "engineer-cli-test" };
    const overrides = { clientSecret: "secret", scope: LOCAL_MCP_CLIENT_ID };
    const session = (): CliIo => io(env, undefined, overrides);
    expect(await runCli(["login", "--client-credentials"], session())).toBe(0);
    expect(out.at(-1)).toContain("client credentials");
    expect(await runCli(["token"], session())).toBe(0);
    const claims = decodeJwt(out.at(-1) as string);
    expect(claims.sub).toBe("engineer-cli-test");
    expect(claims.aud).toBe(LOCAL_MCP_CLIENT_ID);
    const secret = createWatcherCredentialStore(dir).ensure().secret;
    expect(await runCli(["headers"], session())).toBe(0);
    const headers = JSON.parse(out.at(-1) as string) as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["Authorization"]);
    expect(headers.Authorization).toStartWith("Bearer ey");
    expect(out.join("\n")).not.toContain(secret);
    expect(await runCli(["logout"], session())).toBe(0);
    err.length = 0;
    expect(await runCli(["token"], session())).toBe(1);
    expect(err[0]).toContain("not logged in");
    expect(err.join("")).not.toContain("ey");
  });

  test("logout revokes the watcher credential on the server and deletes every local secret", async () => {
    const env = { PW_SUPPORT_CLIENT_ID: "engineer-logout-test" };
    const overrides = { clientSecret: "secret", scope: LOCAL_MCP_CLIENT_ID };
    expect(
      await runCli(
        ["login", "--client-credentials"],
        io(env, undefined, overrides),
      ),
    ).toBe(0);
    const credential = createWatcherCredentialStore(dir).ensure();
    const calls: { method: string; url: string; body: string }[] = [];
    const fetcher = (async (target: unknown, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(target),
        body: String(init?.body ?? ""),
      });
      return Response.json({ revoked: true });
    }) as typeof fetch;
    err.length = 0;
    const session = {
      ...io(env, undefined, { ...overrides, apiUrl: "http://api.test" }),
      fetcher,
    };
    expect(await runCli(["logout"], session)).toBe(0);
    expect(calls).toEqual([
      {
        method: "DELETE",
        url: "http://api.test/laptop/watcher",
        body: JSON.stringify({ machineId: credential.machineId }),
      },
    ]);
    expect(createWatcherCredentialStore(dir).read()).toBeNull();
    expect(createFileTokenStore(dir).read()).toBeNull();
    expect(err).toEqual([]);
  });

  test("logout still clears local state and says so when the server cannot revoke", async () => {
    const env = { PW_SUPPORT_CLIENT_ID: "engineer-logout-fail" };
    const overrides = { clientSecret: "secret", scope: LOCAL_MCP_CLIENT_ID };
    await runCli(
      ["login", "--client-credentials"],
      io(env, undefined, overrides),
    );
    createWatcherCredentialStore(dir).ensure();
    err.length = 0;
    const session = {
      ...io(env, undefined, overrides),
      fetcher: (async () =>
        new Response("down", { status: 503 })) as unknown as typeof fetch,
    };
    expect(await runCli(["logout"], session)).toBe(0);
    expect(err.join("\n")).toContain("did not confirm");
    expect(createWatcherCredentialStore(dir).read()).toBeNull();
    expect(createFileTokenStore(dir).read()).toBeNull();
  });

  test("interactive login completes the PKCE flow against the mock issuer", async () => {
    const env = { PW_SUPPORT_CLIENT_ID: LOCAL_MCP_CLIENT_ID };
    let status = 0;
    const code = await runCli(
      ["login"],
      io(env, async (url) => {
        status = await completeMockLogin(url, {
          username: "ada-cli-test",
          claims: { email: "ada@pressw.test", aud: LOCAL_MCP_CLIENT_ID },
        });
      }),
    );
    expect(code).toBe(0);
    expect(status).toBe(200);
    expect(out.join("\n")).toContain("Opening the browser");
    await runCli(["token"], io(env));
    const claims = decodeJwt(out.at(-1) as string);
    expect(claims.sub).toBe("ada-cli-test");
    expect(claims.aud).toBe(LOCAL_MCP_CLIENT_ID);
  });

  test("login --no-browser prints the url and reports a failed login", async () => {
    const code = await runCli(
      ["login", "--no-browser"],
      io({ PW_SUPPORT_ISSUER: "http://127.0.0.1:1/none" }),
    );
    expect(code).toBe(1);
    expect(err.at(-1)).toBeDefined();
    out.length = 0;
    let printed = "";
    const ok = await runCli(["login", "--no-browser"], {
      ...io({ PW_SUPPORT_CLIENT_ID: LOCAL_MCP_CLIENT_ID }),
      out: (text) => {
        if (!text.startsWith("Open this URL")) return;
        printed = text;
        const url = text.split("\n")[1] as string;
        void completeMockLogin(url, { username: "no-browser" });
      },
    });
    expect(ok).toBe(0);
    expect(printed).toContain("Open this URL");
  });

  test("watch status and stop report a watcher that is not running, and bad usage fails", async () => {
    expect(await runCli(["watch", "status"], io())).toBe(0);
    expect(out.at(-1)).toBe("Watcher is not running.");
    expect(await runCli(["watch", "stop"], io())).toBe(0);
    expect(out.at(-1)).toBe("Watcher is not running.");
    expect(await runCli(["watch", "bogus"], io())).toBe(1);
    expect(await runCli(["submit-server"], io())).toBe(1);
  });

  test("watch start launches a detached watcher and watch stop ends it", async () => {
    const fake = join(dir, "fake-cli.ts");
    await Bun.write(fake, "setInterval(() => {}, 1000);");
    const env = io();
    env.cliPath = fake;
    expect(await runCli(["watch", "start"], env)).toBe(0);
    expect(out.at(-1)).toContain("Watcher started");
    expect(await runCli(["watch", "start"], env)).toBe(0);
    expect(out.at(-1)).toContain("already running");
    expect(await runCli(["watch", "status"], env)).toBe(0);
    expect(out.join("\n")).toContain("Watcher is running");
    expect(await runCli(["watch", "stop"], env)).toBe(0);
    expect(out.at(-1)).toBe("Watcher stopped.");
  });
});
