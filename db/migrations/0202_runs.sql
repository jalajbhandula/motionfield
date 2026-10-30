-- WS2 step 4 — run engine: durable multi-step generation runs.
-- A run = a validated plan (ordered steps over catalog endpoints) plus its
-- estimate/ETA and approval state; each step tracks its own job.
CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  session_id uuid REFERENCES agent_sessions(id) ON DELETE cascade,
  project_id uuid,
  mode text NOT NULL DEFAULT 'auto',          -- auto | offline (planner context)
  status text NOT NULL DEFAULT 'planning',    -- planning | awaiting_approval | running | done | failed | stopped
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,    -- validated Plan {title, steps[]}
  estimate_credits numeric(14,3) NOT NULL DEFAULT 0,
  eta_seconds integer,                        -- null = unknown (no job history yet)
  ask_first boolean NOT NULL DEFAULT false,   -- approval gate input, recorded for audit
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs(user_id, created_at);
CREATE INDEX IF NOT EXISTS agent_runs_session_idx ON agent_runs(session_id);
CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs(status);

CREATE TABLE IF NOT EXISTS run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE cascade,
  idx integer NOT NULL,                       -- plan order; execution is topological
  step_id text NOT NULL,                      -- the plan step's own id ($step refs point at it)
  title text NOT NULL,
  endpoint_id text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,  -- declared params ($step: refs resolved at submit)
  depends_on text[] NOT NULL DEFAULT '{}',    -- step_ids that must finish first
  input_hash text,                            -- sha256(endpoint + resolved params + upstream output hashes), set at submit
  job_id uuid,                                -- the submitted generation job
  status text NOT NULL DEFAULT 'pending',     -- pending | running | done | failed | skipped | canceled
  outputs jsonb NOT NULL DEFAULT '[]'::jsonb, -- the job's output items once done
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, step_id),
  UNIQUE (run_id, idx)
);
CREATE INDEX IF NOT EXISTS run_steps_run_idx ON run_steps(run_id, idx);
CREATE INDEX IF NOT EXISTS run_steps_status_idx ON run_steps(status);
