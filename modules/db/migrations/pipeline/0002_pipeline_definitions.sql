-- Authoring persistence: the pipeline-definition catalog and its append-only
-- version history, plus a nullable `definition_version` pin on pipeline_run.
-- Mirrors src/persistence/schema.ts. Idempotent (IF NOT EXISTS) like the others.

CREATE TABLE IF NOT EXISTS "pipeline_definition" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL DEFAULT 'pw-support',
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pipeline_definition_tenant_name_uq" UNIQUE ("tenant_id", "name")
);

CREATE TABLE IF NOT EXISTS "pipeline_definition_version" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "definition_id" uuid NOT NULL REFERENCES "pipeline_definition" ("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "config_json" jsonb NOT NULL,
  "status" text NOT NULL,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz,
  CONSTRAINT "pipeline_definition_version_def_version_uq" UNIQUE ("definition_id", "version")
);

CREATE INDEX IF NOT EXISTS "pipeline_definition_version_def_status_idx"
  ON "pipeline_definition_version" ("definition_id", "status");

-- At most one draft per definition, enforced by the DB (not app logic).
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_definition_version_one_draft_uq"
  ON "pipeline_definition_version" ("definition_id") WHERE "status" = 'draft';

ALTER TABLE "pipeline_run" ADD COLUMN IF NOT EXISTS "definition_version" integer;
