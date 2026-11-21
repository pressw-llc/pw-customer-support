import { resolveStackEnv } from "@pw-support/contracts";

export type StackCommand = "up" | "down";

export function composeArgs(command: StackCommand): string[] {
  return command === "up"
    ? ["docker", "compose", "up", "-d", "--wait"]
    : ["docker", "compose", "down", "-v"];
}

export function composeEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const stack = resolveStackEnv(env);
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.SUPPORT_POSTGRES_PORT = stack.postgresPort;
  merged.SUPPORT_LOCALSTACK_PORT = stack.localstackPort;
  merged.SUPPORT_OIDC_PORT = stack.oidcPort;
  return merged;
}

export function parseCommand(arg: string | undefined): StackCommand | null {
  return arg === "up" || arg === "down" ? arg : null;
}

export type Spawn = (
  cmd: string[],
  env: Record<string, string>,
) => Promise<number>;

export async function main(
  args: string[],
  spawn: Spawn,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const command = parseCommand(args[0]);
  if (!command) {
    console.error("usage: bun scripts/stack.ts up|down");
    return 2;
  }
  return spawn(composeArgs(command), composeEnv(env));
}

export const spawnCompose: Spawn = async (cmd, env) => {
  const proc = Bun.spawn(cmd, {
    env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return proc.exited;
};

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), spawnCompose));
}
