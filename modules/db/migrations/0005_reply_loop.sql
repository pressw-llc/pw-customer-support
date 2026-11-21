ALTER TABLE support.messages
  ADD COLUMN IF NOT EXISTS author_name text,
  ADD COLUMN IF NOT EXISTS intake_completed_at timestamptz;

CREATE TABLE IF NOT EXISTS support.webhook_deliveries (
  delivery_id text PRIMARY KEY,
  provider text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support.inbound_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'linear',
  comment_id text NOT NULL,
  issue_id text NOT NULL,
  parent_comment_id text,
  author_id text,
  author_name text,
  body text NOT NULL,
  request_id uuid NOT NULL REFERENCES support.requests (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  disposition text,
  message_id uuid REFERENCES support.messages (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT inbound_comments_comment_uq UNIQUE (provider, comment_id),
  CONSTRAINT inbound_comments_status_ck CHECK (status IN ('pending', 'processed'))
);

CREATE INDEX IF NOT EXISTS inbound_comments_pending_idx
  ON support.inbound_comments (created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS support.replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES support.requests (id) ON DELETE CASCADE,
  inbound_comment_id uuid NOT NULL REFERENCES support.inbound_comments (id) ON DELETE CASCADE,
  thread_root_id text NOT NULL,
  author_id text,
  author_name text,
  body text NOT NULL,
  status text NOT NULL,
  hold_reason text,
  wording_score double precision NOT NULL,
  flagged boolean NOT NULL DEFAULT false,
  message_id uuid REFERENCES support.messages (id) ON DELETE SET NULL,
  confirmed_by text,
  warning_comment_id text,
  held_at timestamptz,
  expires_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replies_inbound_uq UNIQUE (inbound_comment_id),
  CONSTRAINT replies_status_ck CHECK (status IN ('held', 'sent', 'expired')),
  CONSTRAINT replies_hold_reason_ck CHECK (
    hold_reason IS NULL OR hold_reason IN ('wording_low', 'wording_unavailable', 'too_long')
  )
);

CREATE INDEX IF NOT EXISTS replies_thread_idx
  ON support.replies (thread_root_id, status);
CREATE INDEX IF NOT EXISTS replies_flagged_idx
  ON support.replies (created_at) WHERE flagged;

CREATE TABLE IF NOT EXISTS support.message_deliveries (
  message_id uuid PRIMARY KEY REFERENCES support.messages (id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES support.requests (id) ON DELETE CASCADE,
  via text,
  linear_comment_id text,
  delivery_attempts integer NOT NULL DEFAULT 0,
  last_enqueued_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_deliveries_via_ck CHECK (via IS NULL OR via IN ('ticket', 'comment')),
  CONSTRAINT message_deliveries_attempts_ck CHECK (delivery_attempts >= 0),
  CONSTRAINT message_deliveries_comment_uq UNIQUE (linear_comment_id)
);

CREATE INDEX IF NOT EXISTS message_deliveries_request_idx
  ON support.message_deliveries (request_id);

INSERT INTO support.message_deliveries (message_id, request_id, via, delivered_at)
SELECT m.id, m.request_id, 'ticket', t.created_at
FROM support.messages m
JOIN support.tickets t ON t.request_id = m.request_id
WHERE m.author = 'customer' AND m.audience = 'external' AND m.created_at <= t.created_at
ON CONFLICT (message_id) DO NOTHING;
