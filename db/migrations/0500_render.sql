-- WS5: render_specs — SceneSpec v1 JSON documents for the deterministic
-- three.js renderer (motion graphics, titles, stage previews).
CREATE TABLE IF NOT EXISTS render_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS render_specs_user_idx ON render_specs(user_id, created_at);
