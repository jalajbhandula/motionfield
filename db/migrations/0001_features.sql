-- 0001: post-login feature surface — profiles+, assets+, elements/folders/follows/comments/notifications/promos/invites

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan_renews_at timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS boost_slots int NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS auto_publish boolean NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS specialty text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS studio text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS interests jsonb NOT NULL DEFAULT '[]';

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS provider_meta jsonb NOT NULL DEFAULT '{}';

ALTER TABLE assets ADD COLUMN IF NOT EXISTS prompt text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS endpoint_id text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS project_id uuid;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS favorite boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS assets_feed_idx ON assets (visibility, created_at DESC);

CREATE TABLE IF NOT EXISTS elements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'character',
  description text,
  images jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS elements_user_idx ON elements (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS elements_user_name_idx ON elements (user_id, name);

CREATE TABLE IF NOT EXISTS folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS folders_user_idx ON folders (user_id);

CREATE TABLE IF NOT EXISTS folder_items (
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (folder_id, asset_id)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  following_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_target_idx ON comments (target_type, target_id);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  href text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS promocodes (
  code text PRIMARY KEY,
  credits numeric(14,3) NOT NULL DEFAULT 0,
  plan_id text,
  max_redemptions int,
  redeemed int NOT NULL DEFAULT 0,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promocode_redemptions (
  code text NOT NULL REFERENCES promocodes(code) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, user_id)
);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_ws_idx ON workspace_invites (workspace_id);
