import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountConflicts,
  ConfigError,
  type ConfigScope,
  isStageName,
  type RawValues,
  resolveStageConfig,
  STAGES,
  type StageAccount,
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

export function otherStageAccounts(
  current: StageName,
  currentAccount: string | undefined,
  dir: string = INFRA_DIR,
): StageAccount[] {
  const entries: StageAccount[] = [{ stage: current, account: currentAccount }];
  for (const stage of STAGES) {
    if (stage === current) continue;
    const file = stageFile(stage, dir);
    if (!existsSync(file)) continue;
    const values = parseJsonObject(readFileSync(file, "utf8"), file);
    entries.push({ stage, account: text(values.account) });
  }
  return entries;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

export function loadStageConfig(options: {
  stage: StageName;
  scope?: ConfigScope;
  placeholders: boolean;
  readContext?: (key: string) => unknown;
  env?: Record<string, string | undefined>;
  dir?: string;
}): StageConfig {
  const config = resolveStageConfig({
    stage: options.stage,
    scope: options.scope,
    placeholders: options.placeholders,
    values: loadStageValues(
      options.stage,
      options.readContext,
      options.env,
      options.dir,
    ),
  });
  const conflicts = accountConflicts(
    otherStageAccounts(options.stage, config.account, options.dir),
  );
  if (conflicts.length > 0) throw new ConfigError(conflicts);
  return config;
}
