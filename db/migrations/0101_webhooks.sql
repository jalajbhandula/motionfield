-- WS1: signed webhook deliveries — one row per job per terminal event type
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  api_key_id uuid,
  type text NOT NULL,
  url text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending',  -- pending | delivering | delivered | failed | exhausted
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_job_type_idx ON webhook_deliveries (job_id, type);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (status, next_attempt_at);
