CREATE TABLE IF NOT EXISTS support.ticket_deliveries (
  request_id uuid PRIMARY KEY REFERENCES support.requests (id) ON DELETE CASCADE,
  delivery_attempts integer NOT NULL DEFAULT 0,
  last_enqueued_at timestamptz NOT NULL,
  CONSTRAINT ticket_deliveries_attempts_ck CHECK (delivery_attempts >= 0)
);
