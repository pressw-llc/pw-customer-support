import { expect, test } from "bun:test";
import {
  composeArgs,
  composeEnv,
  main,
  parseCommand,
  spawnCompose,
} from "./stack";

test("builds the compose commands", () => {
  expect(composeArgs("up")).toEqual([
    "docker",
    "compose",
    "up",
    "-d",
    "--wait",
  ]);
  expect(composeArgs("down")).toEqual(["docker", "compose", "down", "-v"]);
});

test("parses only up and down", () => {
  expect(parseCommand("up")).toBe("up");
  expect(parseCommand("down")).toBe("down");
  expect(parseCommand("restart")).toBeNull();
  expect(parseCommand(undefined)).toBeNull();
});

test("passes the resolved ports to compose", () => {
  const env = composeEnv({
    SUPPORT_POSTGRES_PORT: "6000",
    SUPPORT_LOCALSTACK_PORT: "",
    PATH: "/bin",
    SKIPPED: undefined,
  });
  expect(env.SUPPORT_POSTGRES_PORT).toBe("6000");
  expect(env.SUPPORT_LOCALSTACK_PORT).toBe("4577");
  expect(env.PATH).toBe("/bin");
  expect("SKIPPED" in env).toBe(false);
});

test("composeEnv reads process.env by default", () => {
  expect(composeEnv().SUPPORT_POSTGRES_PORT).toBeTruthy();
});

test("main spawns compose with the resolved ports", async () => {
  const calls: { cmd: string[]; env: Record<string, string> }[] = [];
  const spawn = async (cmd: string[], env: Record<string, string>) => {
    calls.push({ cmd, env });
    return 0;
  };
  const code = await main(["up"], spawn, { SUPPORT_POSTGRES_PORT: "6000" });
  expect(code).toBe(0);
  expect(calls[0]?.cmd).toEqual(composeArgs("up"));
  expect(calls[0]?.env.SUPPORT_POSTGRES_PORT).toBe("6000");
  expect(calls[0]?.env.SUPPORT_LOCALSTACK_PORT).toBe("4577");
});

test("main returns the compose exit code and rejects unknown commands", async () => {
  expect(await main(["down"], async () => 3, {})).toBe(3);
  expect(await main(["bogus"], async () => 0, {})).toBe(2);
});

test("the cli rejects an unknown command", async () => {
  const proc = Bun.spawn(["bun", "scripts/stack.ts", "bogus"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(await proc.exited).toBe(2);
});

test("spawnCompose returns the exit code of the process", async () => {
  const env = { PATH: process.env.PATH ?? "" };
  expect(await spawnCompose(["true"], env)).toBe(0);
  expect(await spawnCompose(["false"], env)).toBe(1);
});
