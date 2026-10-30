-- WS2 step 6 — run modes: 'custom' mode + per-step model pick and effort.
--
-- agent_runs.mode now carries auto | offline | custom (no CHECK on the
-- column — the route/zod enums are the gate; 'custom' = every run parks at
-- awaiting_approval and each step gets a model picker + effort select).
-- run_steps.model_choice records the endpoint the user explicitly picked in
-- Custom mode (null = the planner's choice ran); run_steps.effort records
-- the effort level applied ('draft' | 'standard' | 'high') — the derived
-- params are stored in params like any edit, this column is provenance.

ALTER TABLE run_steps
  ADD COLUMN IF NOT EXISTS model_choice text,
  ADD COLUMN IF NOT EXISTS effort text CHECK (effort IN ('draft','standard','high'));
