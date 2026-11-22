CREATE TABLE IF NOT EXISTS support.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engineer_sub text NOT NULL,
  engineer_email text,
  channel_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_engineer_prefix_uq UNIQUE (engineer_sub, channel_prefix),
  CONSTRAINT subscriptions_prefix_ck CHECK (
    channel_prefix ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*(:[A-Za-z0-9][A-Za-z0-9_.-]*){0,2}$'
  )
);

CREATE INDEX IF NOT EXISTS triage_jobs_offer_idx
  ON support.triage_jobs (created_at)
  WHERE status = 'open' AND laptop_claimed_at IS NULL;

ALTER TABLE support.triage_jobs
  ADD COLUMN IF NOT EXISTS submit_token_hash text;

CREATE TABLE IF NOT EXISTS support.watcher_credentials (
  engineer_sub text NOT NULL,
  machine_id uuid NOT NULL,
  secret_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (engineer_sub, machine_id)
);
