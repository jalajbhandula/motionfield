-- WS1: API keys + v1 job API support columns
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS max_concurrency integer NOT NULL DEFAULT 2;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS webhook_secret text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS api_key_id uuid;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS request_hash text;
CREATE INDEX IF NOT EXISTS jobs_api_key_status_idx ON jobs (api_key_id, status);
