ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
CREATE INDEX IF NOT EXISTS profiles_stripe_customer_idx ON profiles (stripe_customer_id);

CREATE TABLE IF NOT EXISTS stripe_events (
  id text PRIMARY KEY,               -- stripe event id (idempotency)
  type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
