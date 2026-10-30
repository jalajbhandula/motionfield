-- Extras: games — owner-scoped GameSpec documents for /games. is_public opens
-- the read-only share link (/games/play/<id>); everything else is owner-only.
CREATE TABLE IF NOT EXISTS games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title text NOT NULL,
  prompt text NOT NULL,
  spec jsonb NOT NULL,
  via text NOT NULL,
  is_public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS games_user_idx ON games (user_id, updated_at);
