-- WS2 s8 — memory map + project side tables.
--
-- memories: named, user-scoped durable context the planner may quote into a
-- later turn (always DATA-framed). project_id NULL = user-wide; set = only
-- sessions/runs bound to that project retrieve it.
-- memory_links: a memory's pointers at the caller's OWN jobs/uploads/refs —
-- verified at write, hard-deleted with the memory (forget cascades).
-- project_settings / project_folders / project_favs: side tables for the
-- frozen projects surface — the base project/asset tables stay untouched.

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  -- null = user-wide memory; set = bound to that project only
  project_id uuid REFERENCES projects(id) ON DELETE cascade,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'note',            -- note | style | fact | asset
  content text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- one (user, name) — the memory tools and API address memories by name
CREATE UNIQUE INDEX IF NOT EXISTS memories_user_name_idx ON memories(user_id, name);
CREATE INDEX IF NOT EXISTS memories_user_idx ON memories(user_id, updated_at);
CREATE INDEX IF NOT EXISTS memories_project_idx ON memories(project_id);

CREATE TABLE IF NOT EXISTS memory_links (
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE cascade,
  target_type text NOT NULL,                    -- job | upload | ref
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS memory_links_target_idx ON memory_links(target_type, target_id);

-- per-project settings the project page edits — planner instructions first
CREATE TABLE IF NOT EXISTS project_settings (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE cascade,
  instructions text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- named groupings inside a project page
CREATE TABLE IF NOT EXISTS project_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE cascade,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS project_folders_name_idx ON project_folders(project_id, name);
CREATE INDEX IF NOT EXISTS project_folders_project_idx ON project_folders(project_id);

-- pinned targets inside a project (its own jobs/assets, or the owner's uploads)
CREATE TABLE IF NOT EXISTS project_favs (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE cascade,
  target_type text NOT NULL,                    -- job | upload | asset
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, target_type, target_id)
);
