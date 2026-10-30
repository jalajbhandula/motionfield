-- workflow-level remix: snapshot of the resolved Comfy graph per job + graph fork lineage
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS graph_json jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS graph_forked_from uuid;
CREATE INDEX IF NOT EXISTS jobs_graph_fork_idx ON jobs(graph_forked_from);
CREATE INDEX IF NOT EXISTS jobs_parent_idx ON jobs(parent_job_id);
