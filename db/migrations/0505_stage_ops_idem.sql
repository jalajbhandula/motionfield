-- WS5 s4b: stage_op_keys — idempotency keys for POST /api/stage/:id/ops.
-- Scoped per user: (user_id, key) is the dedup tuple; scene_id + body sha256
-- detect a key replayed against a different request (422 IDEMPOTENCY_MISMATCH).
-- Rows expire 24 h after creation (lazy delete on read).
CREATE TABLE IF NOT EXISTS stage_op_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  key text NOT NULL,
  scene_id uuid NOT NULL REFERENCES stage_scenes(id) ON DELETE CASCADE,
  body_hash text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stage_op_keys_user_key_idx ON stage_op_keys (user_id, key);

-- persist whether the create-time refs were actually read by a vision route —
-- the editor's "weren't read" note keys off this, not off missing descriptions
ALTER TABLE stage_scenes ADD COLUMN IF NOT EXISTS refs_read boolean NOT NULL DEFAULT false;
