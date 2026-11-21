import {
  defaultTiming,
  RESOURCE_NAMES,
  TRIAGE_DEFAULTS,
  type TriageTiming,
} from "@pw-support/contracts";

export interface TriageConfig {
  timing: TriageTiming;
  jev: {
    threshold: number;
    timeoutMs: number;
    chunkChars: number;
    judgeImages: boolean;
  };
  extract: {
    maxCharsPerFile: number;
    maxCharsTotal: number;
    maxImages: number;
    maxImageBytes: number;
  };
  agent: {
    model: string;
    id: string | undefined;
    timeoutMs: number;
  };
  wakeQueue: string;
  sweepIntervalMs: number;
  maxWakeDelaySeconds: number;
}

export const DEFAULT_AGENT_MODEL = "claude-sonnet-5-5";

type EnvLike = Record<string, string | undefined>;

function number(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function text(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function loadTimingConfig(env: EnvLike = process.env): TriageTiming {
  return {
    initialDelaySeconds: Math.floor(
      number(env.TRIAGE_INITIAL_DELAY_SECONDS, defaultTiming.initialDelaySeconds),
    ),
    leaseSeconds: Math.max(
      1,
      Math.floor(number(env.TRIAGE_LEASE_SECONDS, defaultTiming.leaseSeconds)),
    ),
    maxAttempts: Math.max(
      1,
      Math.floor(number(env.TRIAGE_MAX_ATTEMPTS, defaultTiming.maxAttempts)),
    ),
    intakeGraceSeconds: Math.floor(
      number(env.TRIAGE_INTAKE_GRACE_SECONDS, defaultTiming.intakeGraceSeconds),
    ),
  };
}

export function loadTriageConfig(env: EnvLike = process.env): TriageConfig {
  return {
    timing: loadTimingConfig(env),
    jev: {
      threshold: number(env.JEV_INJECTION_THRESHOLD, 0.5),
      timeoutMs: number(env.JEV_TIMEOUT_MS, 15_000),
      chunkChars: Math.max(500, number(env.JEV_CHUNK_CHARS, 4_000)),
      judgeImages: flag(env.JEV_JUDGE_IMAGES, false),
    },
    extract: {
      maxCharsPerFile: number(env.TRIAGE_MAX_CHARS_PER_FILE, 20_000),
      maxCharsTotal: number(env.TRIAGE_MAX_CHARS_TOTAL, 60_000),
      maxImages: number(env.TRIAGE_MAX_IMAGES, 6),
      maxImageBytes: 5 * 1024 * 1024,
    },
    agent: {
      model: text(env.TRIAGE_AGENT_MODEL) ?? DEFAULT_AGENT_MODEL,
      id: text(env.TRIAGE_AGENT_ID),
      timeoutMs: number(env.TRIAGE_AGENT_TIMEOUT_SECONDS, 240) * 1000,
    },
    wakeQueue: text(env.TRIAGE_WAKE_QUEUE) ?? RESOURCE_NAMES.triageWakeQueue,
    sweepIntervalMs: number(env.TRIAGE_SWEEP_INTERVAL_SECONDS, 30) * 1000,
    maxWakeDelaySeconds: TRIAGE_DEFAULTS.maxWakeDelaySeconds,
  };
}
