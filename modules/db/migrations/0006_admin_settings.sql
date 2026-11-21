ALTER TABLE support.projects
  ADD COLUMN IF NOT EXISTS severe_cc_emails text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS support.integrations (
  scope text NOT NULL,
  kind text NOT NULL,
  secret_ref text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (scope, kind),
  CONSTRAINT integrations_kind_ck CHECK (
    kind IN ('linear_api_key', 'linear_webhook_secret', 'typesafe_api_key')
  ),
  CONSTRAINT integrations_ref_ck CHECK (secret_ref LIKE 'pw-support/%')
);

CREATE INDEX IF NOT EXISTS requests_created_idx
  ON support.requests (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS messages_staff_idx
  ON support.messages (request_id, created_at)
  WHERE author = 'staff';

CREATE INDEX IF NOT EXISTS events_request_type_idx
  ON support.events (request_id, type);
