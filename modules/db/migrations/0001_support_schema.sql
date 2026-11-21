CREATE SCHEMA IF NOT EXISTS support;

CREATE TABLE IF NOT EXISTS support.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug text NOT NULL,
  project_slug text NOT NULL,
  name text NOT NULL,
  linear_team_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_client_project_uq UNIQUE (client_slug, project_slug)
);

CREATE TABLE IF NOT EXISTS support.project_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES support.projects (id) ON DELETE CASCADE,
  key text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_keys_key_uq UNIQUE (key)
);

CREATE INDEX IF NOT EXISTS project_keys_project_idx
  ON support.project_keys (project_id);

CREATE TABLE IF NOT EXISTS support.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES support.projects (id) ON DELETE CASCADE,
  hashed_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_project_hashed_uq UNIQUE (project_id, hashed_id)
);

CREATE TABLE IF NOT EXISTS support.requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES support.projects (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES support.customers (id) ON DELETE CASCADE,
  channel_key text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requests_status_ck CHECK (status IN ('open', 'triaged', 'closed'))
);

CREATE INDEX IF NOT EXISTS requests_project_created_idx
  ON support.requests (project_id, created_at);
CREATE INDEX IF NOT EXISTS requests_customer_idx
  ON support.requests (customer_id);

CREATE TABLE IF NOT EXISTS support.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES support.requests (id) ON DELETE CASCADE,
  body text NOT NULL,
  body_flagged boolean NOT NULL DEFAULT false,
  origin_channel text NOT NULL,
  author text NOT NULL,
  audience text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_origin_channel_ck
    CHECK (origin_channel IN ('widget', 'linear', 'slack', 'email', 'claude_code')),
  CONSTRAINT messages_author_ck CHECK (author IN ('customer', 'staff', 'system')),
  CONSTRAINT messages_audience_ck CHECK (audience IN ('external', 'internal'))
);

CREATE INDEX IF NOT EXISTS messages_request_created_idx
  ON support.messages (request_id, created_at);

CREATE TABLE IF NOT EXISTS support.attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES support.messages (id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_size_ck CHECK (size_bytes > 0)
);

CREATE INDEX IF NOT EXISTS attachments_message_idx
  ON support.attachments (message_id);

CREATE TABLE IF NOT EXISTS support.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  type text NOT NULL,
  channel_key text NOT NULL,
  request_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_seq_uq UNIQUE (seq)
);

CREATE INDEX IF NOT EXISTS events_request_idx ON support.events (request_id);
CREATE INDEX IF NOT EXISTS events_channel_seq_idx
  ON support.events (channel_key text_pattern_ops, seq);

CREATE OR REPLACE FUNCTION support.reject_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_append_only ON support.events;
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON support.events
  FOR EACH ROW EXECUTE FUNCTION support.reject_event_mutation();

DROP TRIGGER IF EXISTS events_no_truncate ON support.events;
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON support.events
  FOR EACH STATEMENT EXECUTE FUNCTION support.reject_event_mutation();
