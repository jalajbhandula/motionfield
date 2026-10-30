-- WS3: license opt-ins — a user accepting restricted-weight license terms
-- (e.g. LTX-Video Open RAIL-M) gets one row; the license gate checks it.
CREATE TABLE IF NOT EXISTS license_optins (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE cascade,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  version text NOT NULL
);
