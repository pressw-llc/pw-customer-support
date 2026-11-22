ALTER TABLE support.messages
  ADD COLUMN IF NOT EXISTS author_name text,
  ADD COLUMN IF NOT EXISTS intake_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS inserted_at timestamptz;

UPDATE support.messages SET inserted_at = created_at WHERE inserted_at IS NULL;

ALTER TABLE support.messages
  ALTER COLUMN inserted_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN inserted_at SET NOT NULL;

ALTER TABLE support.attachments
  ADD COLUMN IF NOT EXISTS linear_delivered_at timestamptz;

CREATE TABLE IF NOT EXISTS support.webhook_deliveries (
  delivery_id text PRIMARY KEY,
  provider text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_received_idx
  ON support.webhook_deliveries (received_at);

CREATE TABLE IF NOT EXISTS support.inbound_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'linear',
  comment_id text NOT NULL,
  issue_id text NOT NULL,
  parent_comment_id text,
  author_id text,
  author_name text,
  body text NOT NULL,
  request_id uuid REFERENCES support.requests (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  disposition text,
  message_id uuid REFERENCES support.messages (id) ON DELETE SET NULL,
  source_created_at timestamptz NOT NULL DEFAULT now(),
  source_updated_at timestamptz,
  refetch_required boolean NOT NULL DEFAULT false,
  delivery_attempts integer NOT NULL DEFAULT 0,
  last_enqueued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT inbound_comments_comment_uq UNIQUE (provider, comment_id),
  CONSTRAINT inbound_comments_status_ck CHECK (status IN ('pending', 'processed')),
  CONSTRAINT inbound_comments_attempts_ck CHECK (delivery_attempts >= 0),
  CONSTRAINT inbound_comments_request_ck CHECK (
    request_id IS NOT NULL OR status = 'pending' OR disposition IN ('ignored:unknown_issue', 'removed')
  )
);

CREATE INDEX IF NOT EXISTS inbound_comments_pending_idx
  ON support.inbound_comments (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS inbound_comments_orphan_idx
  ON support.inbound_comments (issue_id) WHERE request_id IS NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS inbound_comments_thread_idx
  ON support.inbound_comments (request_id, parent_comment_id);

CREATE TABLE IF NOT EXISTS support.comment_changes (
  provider text NOT NULL DEFAULT 'linear',
  comment_id text NOT NULL,
  action text NOT NULL,
  updated_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, comment_id),
  CONSTRAINT comment_changes_action_ck CHECK (action IN ('update', 'remove'))
);

CREATE INDEX IF NOT EXISTS comment_changes_recorded_idx
  ON support.comment_changes (recorded_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tickets_linear_issue_uq'
      AND conrelid = 'support.tickets'::regclass
  ) THEN
    ALTER TABLE support.tickets
      ADD CONSTRAINT tickets_linear_issue_uq UNIQUE (linear_issue_id);
  END IF;
END $$;

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
  cancel_reason text,
  wording_score double precision NOT NULL,
  flagged boolean NOT NULL DEFAULT false,
  message_id uuid REFERENCES support.messages (id) ON DELETE CASCADE,
  confirmed_by text,
  warning_comment_id text,
  cancel_notice_comment_id text,
  held_at timestamptz,
  expires_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replies_inbound_uq UNIQUE (inbound_comment_id),
  CONSTRAINT replies_status_ck CHECK (status IN ('held', 'sent', 'expired', 'cancelled')),
  CONSTRAINT replies_hold_reason_ck CHECK (
    hold_reason IS NULL OR hold_reason IN ('wording_low', 'wording_unavailable', 'too_long')
  ),
  CONSTRAINT replies_cancel_reason_ck CHECK (
    (status = 'cancelled') = (cancel_reason IS NOT NULL)
    AND (cancel_reason IS NULL OR cancel_reason IN ('edited', 'removed'))
  ),
  CONSTRAINT replies_held_expiry_ck CHECK (status <> 'held' OR expires_at IS NOT NULL),
  CONSTRAINT replies_sent_message_ck CHECK (status <> 'sent' OR message_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS replies_thread_idx
  ON support.replies (thread_root_id, status);
CREATE INDEX IF NOT EXISTS replies_flagged_idx
  ON support.replies (created_at) WHERE flagged;
CREATE INDEX IF NOT EXISTS replies_held_expiry_idx
  ON support.replies (expires_at) WHERE status = 'held';

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

CREATE INDEX IF NOT EXISTS events_message_created_seq_idx
  ON support.events (seq) WHERE type = 'message.created';
CREATE INDEX IF NOT EXISTS events_message_created_ref_idx
  ON support.events (((payload->>'messageId')::uuid)) WHERE type = 'message.created';
CREATE INDEX IF NOT EXISTS events_comment_received_seq_idx
  ON support.events (seq) WHERE type = 'comment.received';
CREATE INDEX IF NOT EXISTS events_comment_received_ref_idx
  ON support.events (((payload->>'inboundId')::uuid)) WHERE type = 'comment.received';
CREATE INDEX IF NOT EXISTS events_triage_accepted_seq_idx
  ON support.events (seq) WHERE type = 'triage.result.accepted';

INSERT INTO support.message_deliveries (message_id, request_id, via, delivered_at)
SELECT m.id, m.request_id, 'ticket', t.created_at
FROM support.messages m
JOIN support.tickets t ON t.request_id = m.request_id
WHERE m.author = 'customer' AND m.audience = 'external' AND m.created_at <= t.created_at
ON CONFLICT (message_id) DO NOTHING;

UPDATE support.attachments a
SET linear_delivered_at = d.delivered_at
FROM support.message_deliveries d
WHERE d.message_id = a.message_id
  AND d.delivered_at IS NOT NULL
  AND a.linear_delivered_at IS NULL;
