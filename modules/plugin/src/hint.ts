import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "pw-support",
);

export function cliCommand(subcommand: string): string {
  return `"${BIN_PATH}" ${subcommand}`;
}
