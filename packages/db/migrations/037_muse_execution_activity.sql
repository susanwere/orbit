-- Additive: old jobs have no detailed activity; do not synthesize historical events.
ALTER TABLE muse_execution_jobs
  ADD CONSTRAINT muse_jobs_activity_scope UNIQUE (organization_id, project_id, id);
CREATE TABLE muse_execution_activity (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('preparing','execution','tools','output')),
  status TEXT NOT NULL CHECK (status IN ('started','info','completed','failed')),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 400),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, project_id, job_id)
    REFERENCES muse_execution_jobs(organization_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_muse_activity_job ON muse_execution_activity(organization_id, project_id, job_id, id DESC);
