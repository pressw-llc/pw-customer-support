ALTER TABLE support.messages
  ADD COLUMN IF NOT EXISTS sanitized_body text;

ALTER TABLE support.requests
  ADD COLUMN IF NOT EXISTS customer_last_read_at timestamptz;

CREATE TABLE IF NOT EXISTS support.attachment_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES support.messages (id) ON DELETE CASCADE,
  filename text NOT NULL,
  size_bytes bigint NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachment_rejections_reason_ck CHECK (
    reason IN (
      'too_many_files', 'too_large', 'empty', 'executable',
      'video', 'type_not_allowed', 'storage_failed'
    )
  )
);

CREATE INDEX IF NOT EXISTS attachment_rejections_message_idx
  ON support.attachment_rejections (message_id);

CREATE TABLE IF NOT EXISTS support.rate_limits (
  scope text NOT NULL,
  subject text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, subject, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limits_window_idx
  ON support.rate_limits (window_start);
