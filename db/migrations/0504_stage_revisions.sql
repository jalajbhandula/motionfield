-- WS5 s4b: stage_revisions — an append-mostly history of scene snapshots.
-- One row per committed head: create/prompt/ops/restore always append; the
-- editor's autosave (source 'save') carries a per-load session_id so a
-- session's saves collapse into its latest row instead of flooding history.
-- revision mirrors stage_scenes.revision at commit time; (scene_id, revision)
-- unique. Pruned to the newest 200 rows per scene, head excluded from pruning.
CREATE TABLE IF NOT EXISTS stage_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id uuid NOT NULL REFERENCES stage_scenes(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  source text NOT NULL CHECK (source IN ('create','save','prompt','ops','restore')),
  session_id text,
  scene jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stage_revisions_rev_idx ON stage_revisions (scene_id, revision);
CREATE INDEX IF NOT EXISTS stage_revisions_scene_idx ON stage_revisions (scene_id, created_at);
