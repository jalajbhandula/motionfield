-- WS1 s8: idempotency ledger for POST /api/v1/runs.
-- agent_runs is the run engine's own table (WS2-owned) and has no
-- idempotency column, so v1 keeps a key→run ledger of its own — the same
-- shape as the jobs row's (api_key scope is the user, plus a request hash
-- that catches key reuse with a different payload).
--
-- run_id is intentionally NOT a foreign key: this file's 01xx name sorts
-- before WS2's 02xx migrations, so agent_runs doesn't exist here yet and
-- no later WS1 filename can follow it. Cleanup still cascades through
-- user_id (a deleted user takes the whole ledger), and runs have no
-- delete path today, so a stored run_id can't dangle in practice.
--
-- run_id starts NULL: the row is RESERVED before planning/create runs
-- (planner calls can take minutes) so a concurrent same-key request sees
-- the reservation and answers 409 idempotency_in_progress rather than
-- minting a second run. Success UPDATEs run_id; a create-path failure
-- DELETEs the reservation.

CREATE TABLE IF NOT EXISTS v1_run_idem (
  user_id         text        NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  idempotency_key text        NOT NULL,
  request_hash    text,
  run_id          uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS v1_run_idem_run_idx ON v1_run_idem (run_id);
