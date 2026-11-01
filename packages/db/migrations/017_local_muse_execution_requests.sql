-- The authenticated browser requests local execution; a trusted host consumer
-- prepares Docker and executes it. The API never receives Docker access.
ALTER TABLE muse_execution_jobs
  ADD COLUMN local_execution_requested_at TIMESTAMPTZ,
  ADD COLUMN local_execution_state TEXT CHECK (local_execution_state IN ('REQUESTED','PREPARING','RUNNING','FINISHED','ERROR')),
  ADD COLUMN local_execution_error TEXT CHECK (length(local_execution_error) <= 1000);
CREATE INDEX idx_muse_local_requests ON muse_execution_jobs(local_execution_requested_at)
  WHERE status='QUEUED' AND local_execution_state='REQUESTED';
