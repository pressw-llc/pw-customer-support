CREATE TABLE IF NOT EXISTS support.channel_delays (
  delay_channel text PRIMARY KEY,
  current_delay_seconds integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_delays_nonneg_ck CHECK (current_delay_seconds >= 0)
);

CREATE TABLE IF NOT EXISTS support.triage_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES support.requests (id) ON DELETE CASCADE,
  channel_key text NOT NULL,
  delay_channel text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  cloud_available_at timestamptz NOT NULL,
  intake_completed_at timestamptz,
  laptop_claimed_at timestamptz,
  claimed_by_kind text,
  claimed_by text,
  claim_token uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  outcome text,
  result jsonb,
  agent_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT triage_jobs_request_uq UNIQUE (request_id),
  CONSTRAINT triage_jobs_status_ck CHECK (status IN ('open', 'claimed', 'completed')),
  CONSTRAINT triage_jobs_kind_ck CHECK (
    claimed_by_kind IS NULL OR claimed_by_kind IN ('laptop', 'cloud')
  ),
  CONSTRAINT triage_jobs_outcome_ck CHECK (
    outcome IS NULL OR outcome IN ('agent', 'human_triage')
  ),
  CONSTRAINT triage_jobs_claim_ck CHECK (
    status <> 'claimed' OR (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS triage_jobs_status_idx
  ON support.triage_jobs (status, cloud_available_at);
CREATE INDEX IF NOT EXISTS triage_jobs_channel_idx
  ON support.triage_jobs (channel_key text_pattern_ops);

CREATE TABLE IF NOT EXISTS support.judgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES support.requests (id) ON DELETE CASCADE,
  kind text NOT NULL,
  subject text NOT NULL,
  score double precision NOT NULL,
  threshold double precision NOT NULL,
  flagged boolean NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS judgments_request_idx
  ON support.judgments (request_id, kind);

CREATE TABLE IF NOT EXISTS support.event_cursors (
  adapter text PRIMARY KEY,
  last_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES support.requests (id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'linear',
  linear_issue_id text NOT NULL,
  identifier text NOT NULL,
  url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tickets_request_uq UNIQUE (request_id)
);
