-- WS5: render_specs metadata for the Motion Graphics flow —
-- display title, the originating prompt, the brand source URL, and
-- refine lineage (parent_id).
ALTER TABLE render_specs ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE render_specs ADD COLUMN IF NOT EXISTS prompt text;
ALTER TABLE render_specs ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE render_specs ADD COLUMN IF NOT EXISTS parent_id uuid;
