import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isStageName,
  type RawValues,
  resolveStageConfig,
  type StageConfig,
  type StageName,
  stageValuesFrom,
} from "./config";

export const INFRA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export function stageFile(stage: StageName, dir: string = INFRA_DIR): string {
  return join(dir, `stage.${stage}.json`);
}

export function parseJsonObject(raw: string, source: string): RawValues {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object`);
  }
  return parsed as RawValues;
}

export function loadStageValues(
  stage: StageName,
  readContext: (key: string) => unknown = () => undefined,
  env: Record<string, string | undefined> = process.env,
  dir: string = INFRA_DIR,
): RawValues {
  const file = stageFile(stage, dir);
  const fromFile = existsSync(file)
    ? parseJsonObject(readFileSync(file, "utf8"), file)
    : {};
  const fromEnv = env.SUPPORT_STAGE_CONFIG
    ? parseJsonObject(env.SUPPORT_STAGE_CONFIG, "SUPPORT_STAGE_CONFIG")
    : {};
  return stageValuesFrom(readContext, { ...fromFile, ...fromEnv });
}

export function parseStage(value: unknown): StageName {
  const name = typeof value === "string" ? value : "production";
  if (!isStageName(name)) throw new Error(`unknown stage "${name}"`);
  return name;
}

export function loadStageConfig(options: {
  stage: StageName;
  placeholders: boolean;
  readContext?: (key: string) => unknown;
  env?: Record<string, string | undefined>;
  dir?: string;
}): StageConfig {
  return resolveStageConfig({
    stage: options.stage,
    placeholders: options.placeholders,
    values: loadStageValues(
      options.stage,
      options.readContext,
      options.env,
      options.dir,
    ),
  });
}
