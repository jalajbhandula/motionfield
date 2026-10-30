-- WS1: provenance tag on jobs/assets/uploads.
-- "ui" is the default (in-app submissions); api/cli/mcp come from the
-- X-MotionField-Source header, "agent" is reserved for the in-app agent lane.

ALTER TABLE jobs    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ui';
ALTER TABLE assets  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ui';
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ui';

-- Constraints have no IF NOT EXISTS form — drop-then-add keeps the file
-- re-runnable (e.g. a DB where the columns exist but _migrations was reset).
ALTER TABLE jobs    DROP CONSTRAINT IF EXISTS jobs_source_check;
ALTER TABLE jobs    ADD CONSTRAINT jobs_source_check    CHECK (source IN ('ui','api','cli','mcp','agent'));
ALTER TABLE assets  DROP CONSTRAINT IF EXISTS assets_source_check;
ALTER TABLE assets  ADD CONSTRAINT assets_source_check  CHECK (source IN ('ui','api','cli','mcp','agent'));
ALTER TABLE uploads DROP CONSTRAINT IF EXISTS uploads_source_check;
ALTER TABLE uploads ADD CONSTRAINT uploads_source_check CHECK (source IN ('ui','api','cli','mcp','agent'));

CREATE INDEX IF NOT EXISTS jobs_source_idx   ON jobs (source);
CREATE INDEX IF NOT EXISTS assets_source_idx ON assets (source);
