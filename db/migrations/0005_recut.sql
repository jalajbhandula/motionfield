-- ReCut shot chains: a reference edit decomposed into shots, each regenerated
CREATE TABLE IF NOT EXISTS recut_chains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  video_url text NOT NULL,
  flow text NOT NULL,                  -- motion-transfer | object-swap | restyle
  instructions text,
  image_urls jsonb NOT NULL DEFAULT '[]',
  preset_id text,
  shots jsonb NOT NULL DEFAULT '[]',   -- [{index,start,end,hint?}]
  shot_outputs jsonb NOT NULL DEFAULT '[]', -- [{index,url,job_id}] once assembled
  status text NOT NULL DEFAULT 'queued', -- queued | running | assembling | completed | failed
  result_url text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recut_chains_user_idx ON recut_chains(user_id, created_at);
