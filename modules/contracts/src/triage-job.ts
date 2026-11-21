import { z } from "zod";
import { parseChannelKey } from "./channel-key";
import type { TriageResult } from "./triage-result";

export const triageJobStatuses = ["open", "claimed", "completed"] as const;
export const triageJobStatusSchema = z.enum(triageJobStatuses);
export type TriageJobStatus = z.infer<typeof triageJobStatusSchema>;

export const claimantKinds = ["laptop", "cloud"] as const;
export const claimantKindSchema = z.enum(claimantKinds);
export type ClaimantKind = z.infer<typeof claimantKindSchema>;

export const triageOutcomes = ["agent", "human_triage"] as const;
export const triageOutcomeSchema = z.enum(triageOutcomes);
export type TriageOutcome = z.infer<typeof triageOutcomeSchema>;

export const humanTriageReasons = [
  "injection_flagged",
  "filter_unavailable",
  "agent_output_invalid",
  "agent_error",
  "attempts_exhausted",
] as const;
export const humanTriageReasonSchema = z.enum(humanTriageReasons);
export type HumanTriageReason = z.infer<typeof humanTriageReasonSchema>;

export const HUMAN_TRIAGE_TITLE = "Support request needs human triage";
export const HUMAN_TRIAGE_SUMMARY =
  "Automated triage did not produce a summary for this request. A person must read the request and decide the next step.";
export const HUMAN_TRIAGE_LABEL = "needs-human-triage";

export function humanTriageResult(): TriageResult {
  return {
    title: HUMAN_TRIAGE_TITLE,
    summary: HUMAN_TRIAGE_SUMMARY,
    category: "other",
    priority: "medium",
    labels: [],
    needs_human: true,
  };
}

export const TRIAGE_DEFAULTS = {
  initialDelaySeconds: 60,
  leaseSeconds: 120,
  maxAttempts: 3,
  intakeGraceSeconds: 300,
  maxWakeDelaySeconds: 900,
} as const;

export interface TriageTiming {
  initialDelaySeconds: number;
  leaseSeconds: number;
  maxAttempts: number;
  intakeGraceSeconds: number;
}

export const defaultTiming: TriageTiming = {
  initialDelaySeconds: TRIAGE_DEFAULTS.initialDelaySeconds,
  leaseSeconds: TRIAGE_DEFAULTS.leaseSeconds,
  maxAttempts: TRIAGE_DEFAULTS.maxAttempts,
  intakeGraceSeconds: TRIAGE_DEFAULTS.intakeGraceSeconds,
};

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadTimingConfig(
  env: Record<string, string | undefined> = process.env,
): TriageTiming {
  return {
    initialDelaySeconds: Math.floor(
      envNumber(
        env.TRIAGE_INITIAL_DELAY_SECONDS,
        defaultTiming.initialDelaySeconds,
      ),
    ),
    leaseSeconds: Math.max(
      1,
      Math.floor(
        envNumber(env.TRIAGE_LEASE_SECONDS, defaultTiming.leaseSeconds),
      ),
    ),
    maxAttempts: Math.max(
      1,
      Math.floor(envNumber(env.TRIAGE_MAX_ATTEMPTS, defaultTiming.maxAttempts)),
    ),
    intakeGraceSeconds: Math.floor(
      envNumber(
        env.TRIAGE_INTAKE_GRACE_SECONDS,
        defaultTiming.intakeGraceSeconds,
      ),
    ),
  };
}

export function halveDelay(current: number): number {
  return Math.floor(current / 2);
}

export function delayChannelFor(channelKey: string): string {
  const { client, project } = parseChannelKey(channelKey);
  return project === undefined ? client : `${client}:${project}`;
}

export const wakeInputSchema = z.object({ jobId: z.string().uuid() });
export type WakeInput = z.infer<typeof wakeInputSchema>;

export const wakeMessageSchema = z.object({
  pipelineRunId: z.string().uuid(),
  stepName: z.literal("triage"),
  input: wakeInputSchema,
});
export type WakeMessage = z.infer<typeof wakeMessageSchema>;

export interface WakeSender {
  send(jobId: string, delaySeconds: number): Promise<void>;
}

export function buildWakeMessage(jobId: string): WakeMessage {
  return {
    pipelineRunId: crypto.randomUUID(),
    stepName: "triage",
    input: { jobId },
  };
}
