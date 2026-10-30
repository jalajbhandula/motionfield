-- MotionField initial schema — better-auth core + app tables
CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  handle text UNIQUE,
  display_name text,
  bio text,
  avatar_url text,
  plan_id text NOT NULL DEFAULT 'free',
  credits numeric(14,3) NOT NULL DEFAULT 0,
  onboarded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  pooled_credits boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  delta numeric(14,3) NOT NULL,
  balance_after numeric(14,3) NOT NULL,
  kind text NOT NULL,
  ref_type text,
  ref_id text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_created_idx ON credit_ledger (user_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind text NOT NULL,
  model_id text NOT NULL,
  endpoint_id text NOT NULL,
  workflow text NOT NULL,
  title text,
  prompt text,
  params jsonb NOT NULL DEFAULT '{}',
  inputs jsonb NOT NULL DEFAULT '[]',
  preset_id text,
  preset_kind text,
  provider text NOT NULL,
  provider_request_id text,
  status text NOT NULL DEFAULT 'queued',
  progress int NOT NULL DEFAULT 0,
  cost_credits numeric(14,3) NOT NULL DEFAULT 0,
  outputs jsonb NOT NULL DEFAULT '[]',
  error text,
  idempotency_key text,
  project_id uuid,
  parent_job_id uuid,
  visibility text NOT NULL DEFAULT 'private',
  likes_count int NOT NULL DEFAULT 0,
  lease_until timestamptz,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_user_created_idx ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_lease_idx ON jobs (status, lease_until);
CREATE INDEX IF NOT EXISTS jobs_feed_idx ON jobs (visibility, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idem_idx ON jobs (user_id, idempotency_key);

CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  job_id uuid,
  kind text NOT NULL,
  url text NOT NULL,
  mime text,
  width int,
  height int,
  duration_sec numeric(10,3),
  bytes int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_user_idx ON assets (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  url text NOT NULL,
  mime text NOT NULL,
  bytes int NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uploads_user_idx ON uploads (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  model_version text NOT NULL DEFAULT 'v2',
  status text NOT NULL DEFAULT 'queued',
  thumbnail_url text,
  input_images jsonb NOT NULL DEFAULT '[]',
  provider_ref_id text,
  fail_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS characters_user_idx ON characters (user_id);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  description text,
  cover_url text,
  visibility text NOT NULL DEFAULT 'private',
  likes_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_user_idx ON projects (user_id);
CREATE INDEX IF NOT EXISTS projects_public_idx ON projects (visibility, created_at DESC);

CREATE TABLE IF NOT EXISTS project_items (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, job_id)
);

CREATE TABLE IF NOT EXISTS likes (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  key_id text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  label text NOT NULL DEFAULT 'default',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS rate_buckets (
  key text PRIMARY KEY,
  tokens numeric(14,3) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
