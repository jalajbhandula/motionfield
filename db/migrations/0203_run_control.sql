-- WS2 step 5 — run control: paused status, durable run events, step revisions.
--
-- 'paused' is a run status: no new step claims while set, in-flight steps
-- finish their job and reconcile, and resume re-enters the running state.
-- run_events is the append-only audit feed behind GET /runs/:id/events (SSE)
-- and the step-5 task tree. run_step_revisions snapshots a step's spec each
-- time editStep changes it — the previous spec stays auditable, keyed by rev.

ALTER TABLE run_steps
  ADD COLUMN IF NOT EXISTS rev integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS run_step_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE cascade,
  run_step_id uuid NOT NULL REFERENCES run_steps(id) ON DELETE cascade,
  step_id text NOT NULL,                    -- the step's plan id at snapshot time
  rev integer NOT NULL,                     -- the rev this spec ran under
  title text NOT NULL,
  endpoint_id text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  depends_on text[] NOT NULL DEFAULT '{}',
  input_hash text,                          -- input hash computed under this spec
  job_id uuid,                              -- job submitted under this spec (if any)
  status text NOT NULL,                     -- the step status when superseded
  outputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  replaced_by_step_id text,                 -- non-null when an edit superseded under a different step_id
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_step_id, rev)
);
CREATE INDEX IF NOT EXISTS run_step_revisions_step_idx ON run_step_revisions(run_step_id, rev);
CREATE INDEX IF NOT EXISTS run_step_revisions_run_idx ON run_step_revisions(run_id);

CREATE TABLE IF NOT EXISTS run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE cascade,
  user_id text NOT NULL,                    -- denormalized for owner-scoped reads
  seq bigserial,                            -- global monotonic order (per-run order = seq)
  kind text NOT NULL,                       -- run_created | run_approved | run_paused | run_resumed
                                          -- | run_done | run_failed | run_stopped | step_queued
                                          -- | step_running | step_done | step_failed | step_skipped
                                          -- | step_canceled | step_waiting | step_edited | step_reset
                                          -- | run_reopened | run_awaiting_approval (post-edit gate)
  step_id text,                             -- run_steps.step_id when the event is step-scoped
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id, seq);

-- s5fix: planner provenance on the run node — the route that produced the
-- plan and the fallback/error note when the LLM route failed and the
-- built-in planner took over. Display-only; both may be null.
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS via text,
  ADD COLUMN IF NOT EXISTS planner_note text;
CREATE INDEX IF NOT EXISTS run_events_user_idx ON run_events(user_id, created_at);
