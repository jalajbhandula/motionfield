-- WS2 s8fix — folders hold project items.
-- project_favs.folder_id files a pinned item under a project folder; NULL =
-- pinned but unfiled. Deleting the folder unfiles its items (SET NULL) —
-- nothing is ever unpinned by a folder delete.

ALTER TABLE project_favs
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES project_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS project_favs_folder_idx ON project_favs(folder_id);
