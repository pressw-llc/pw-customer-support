-- Initial @pressw/pipeline schema. Mirrors src/persistence/schema.ts and the
-- shape locked in spec §9. Run with psql or drizzle-kit migrate.

CREATE TABLE IF NOT EXISTS "task_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_type" text NOT NULL,
  "triggered_by" text NOT NULL,
  "triggered_by_actor" text,
  "input_payload" jsonb,
  "status" text NOT NULL,
  "child_pipeline_run_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "failure_reason" text
);

CREATE INDEX IF NOT EXISTS "task_run_status_idx" ON "task_run" ("status");
CREATE INDEX IF NOT EXISTS "task_run_type_created_idx" ON "task_run" ("task_type", "created_at");

CREATE TABLE IF NOT EXISTS "pipeline_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_run_id" uuid,
  "pipeline_name" text NOT NULL,
  "target_record_id" text,
  "status" text NOT NULL,
  "current_step" text,
  "triggered_by" text,
  "input_payload" jsonb,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "failure_reason" text
);

CREATE INDEX IF NOT EXISTS "pipeline_run_status_idx" ON "pipeline_run" ("status");
CREATE INDEX IF NOT EXISTS "pipeline_run_task_run_idx" ON "pipeline_run" ("task_run_id");
CREATE INDEX IF NOT EXISTS "pipeline_run_name_started_idx" ON "pipeline_run" ("pipeline_name", "started_at");
CREATE INDEX IF NOT EXISTS "pipeline_run_target_record_idx" ON "pipeline_run" ("target_record_id");

CREATE TABLE IF NOT EXISTS "pipeline_step_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pipeline_run_id" uuid NOT NULL,
  "step_name" text NOT NULL,
  "status" text NOT NULL,
  "input" jsonb,
  "output" jsonb,
  "attempt" integer NOT NULL DEFAULT 1,
  "runtime" text,
  "worker_id" text,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "duration_ms" integer,
  "failure_reason" text,
  "agent_session_id" text,
  CONSTRAINT "pipeline_step_run_run_step_attempt_uq" UNIQUE ("pipeline_run_id", "step_name", "attempt")
);

CREATE INDEX IF NOT EXISTS "pipeline_step_run_run_idx" ON "pipeline_step_run" ("pipeline_run_id");
CREATE INDEX IF NOT EXISTS "pipeline_step_run_status_started_idx" ON "pipeline_step_run" ("status", "started_at");
CREATE INDEX IF NOT EXISTS "pipeline_step_run_agent_session_idx" ON "pipeline_step_run" ("agent_session_id");
