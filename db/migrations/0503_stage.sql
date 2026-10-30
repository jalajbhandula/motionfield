-- WS5: stage_scenes — owner-scoped grey-box scene documents for /stage.
-- revision drives optimistic concurrency on the editor's autosave; refs
-- holds owned upload attachments (url + optional vision description).
CREATE TABLE IF NOT EXISTS stage_scenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title text NOT NULL,
  scene jsonb NOT NULL,
  refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stage_scenes_user_idx ON stage_scenes (user_id, updated_at);
