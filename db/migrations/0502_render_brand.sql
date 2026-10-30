-- WS5: render_specs — brand context captured at generate time (refine reuses
-- it instead of re-fetching), and parent_id becomes a real self-FK so deleting
-- a parent spec leaves children with parent_id NULL rather than dangling.
ALTER TABLE render_specs ADD COLUMN IF NOT EXISTS brand jsonb;

ALTER TABLE render_specs DROP CONSTRAINT IF EXISTS render_specs_parent_id_fkey;
ALTER TABLE render_specs
  ADD CONSTRAINT render_specs_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES render_specs(id) ON DELETE SET NULL;
