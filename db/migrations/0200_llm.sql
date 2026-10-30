-- WS2 "Brain" — LLM layer: per-user provider credentials + per-task routes.
-- api_key_enc is AES-256-GCM (HKDF-SHA256 data key from BETTER_AUTH_SECRET)
-- plaintext keys never reach the client.
CREATE TABLE IF NOT EXISTS llm_provider_settings (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  provider_id text NOT NULL,
  base_url text,
  api_key_enc text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider_id)
);

CREATE TABLE IF NOT EXISTS llm_task_routes (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  task text NOT NULL,           -- planner | writer | vision | coder | enhancer | judge
  provider_id text NOT NULL,
  model text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, task)
);
