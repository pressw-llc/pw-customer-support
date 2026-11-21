-- Adds `activity_log` (spec §9 + R15 of the M1 plan). Written by step
-- handlers via ctx.activityLog(...) and by the runner for session lifecycle,
-- HITL requests, and retries. Append-only; observational queries only.

CREATE TABLE IF NOT EXISTS "activity_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pipeline_run_id" uuid,
  "step_run_id" uuid,
  "task_run_id" uuid,
  "level" text NOT NULL,
  "message" text NOT NULL,
  "data" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "activity_log_run_created_idx" ON "activity_log" ("pipeline_run_id", "created_at");
CREATE INDEX IF NOT EXISTS "activity_log_step_idx" ON "activity_log" ("step_run_id");
CREATE INDEX IF NOT EXISTS "activity_log_task_created_idx" ON "activity_log" ("task_run_id", "created_at");
