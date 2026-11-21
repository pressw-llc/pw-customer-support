import { z } from "zod";

export const triageCategories = [
  "bug",
  "question",
  "feature_request",
  "account",
  "billing",
  "other",
] as const;
export const triageCategorySchema = z.enum(triageCategories);

export const triagePriorities = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;
export const triagePrioritySchema = z.enum(triagePriorities);

export const triageLabels = [
  "bug",
  "feature",
  "question",
  "ux",
  "performance",
  "data",
  "integration",
  "security",
  "needs-info",
] as const;
export const triageLabelSchema = z.enum(triageLabels);

export type TriageLabel = z.infer<typeof triageLabelSchema>;
export type TriagePriority = z.infer<typeof triagePrioritySchema>;

export const TRIAGE_LIMITS = {
  titleMax: 120,
  summaryMax: 2000,
  labelsMax: 5,
} as const;

export const triageResultSchema = z
  .object({
    title: z.string().trim().min(1).max(TRIAGE_LIMITS.titleMax),
    summary: z.string().trim().min(1).max(TRIAGE_LIMITS.summaryMax),
    category: triageCategorySchema,
    priority: triagePrioritySchema,
    labels: z
      .array(triageLabelSchema)
      .max(TRIAGE_LIMITS.labelsMax)
      .refine((labels) => new Set(labels).size === labels.length, {
        message: "Labels must be unique",
      }),
    needs_human: z.boolean(),
  })
  .strict();
export type TriageResult = z.infer<typeof triageResultSchema>;
