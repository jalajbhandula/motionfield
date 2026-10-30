-- WS2 s3c — Hugging Face hub download records.
-- One row per user request: ComfyUI weights into models/<subfolder> or a
-- GGUF pull through Ollama. Progress while running lives in a globalThis
-- registry; this table is the durable audit (repo@revision, file, checksum,
-- licence id/class as classified server-side).
CREATE TABLE IF NOT EXISTS hub_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  kind text NOT NULL,                        -- weights | gguf
  repo text NOT NULL,                        -- owner/name
  revision text NOT NULL,                    -- pinned commit sha
  file text NOT NULL,                        -- repo-relative path
  subfolder text,                            -- ComfyUI models/ subdir (null = ollama pull)
  sha256 text,                               -- LFS sha256 (or git blob sha1) that was verified
  bytes bigint NOT NULL DEFAULT 0,           -- declared file size
  licence_id text NOT NULL DEFAULT '',       -- the licence id that set the class
  licence_class text NOT NULL DEFAULT '',    -- open | permissive-terms | restricted
  status text NOT NULL DEFAULT 'running',    -- running | done | failed | canceled
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_downloads_user_idx ON hub_downloads(user_id, created_at);
