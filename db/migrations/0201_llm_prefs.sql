-- WS2 s3: wire column for per-provider/per-task wire overrides (the Custom
-- provider), and llm_user_prefs for the persisted Offline toggle.
ALTER TABLE llm_provider_settings ADD COLUMN IF NOT EXISTS wire text;
ALTER TABLE llm_task_routes ADD COLUMN IF NOT EXISTS wire text;

CREATE TABLE IF NOT EXISTS llm_user_prefs (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  offline boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
