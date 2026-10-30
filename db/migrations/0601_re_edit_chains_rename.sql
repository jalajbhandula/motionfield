-- Rename recut_chains → re_edit_chains (public name: Re-edit Video).
-- The migrator splits on ";" so no DO blocks — this is pure DDL that works
-- whether the old table exists (data is copied over) or not.
CREATE TABLE IF NOT EXISTS re_edit_chains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  video_url text NOT NULL,
  flow text NOT NULL,
  instructions text,
  image_urls jsonb NOT NULL DEFAULT '[]',
  preset_id text,
  shots jsonb NOT NULL DEFAULT '[]',
  shot_outputs jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'queued',
  result_url text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recut_chains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  video_url text NOT NULL,
  flow text NOT NULL,
  instructions text,
  image_urls jsonb NOT NULL DEFAULT '[]',
  preset_id text,
  shots jsonb NOT NULL DEFAULT '[]',
  shot_outputs jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'queued',
  result_url text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO re_edit_chains SELECT * FROM recut_chains ON CONFLICT (id) DO NOTHING;
DROP TABLE recut_chains;
CREATE INDEX IF NOT EXISTS re_edit_chains_user_idx ON re_edit_chains(user_id, created_at);
