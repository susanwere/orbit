ALTER TABLE muse_execution_jobs ADD COLUMN lease_expires_at TIMESTAMPTZ;
CREATE INDEX idx_muse_jobs_expired_lease ON muse_execution_jobs(lease_expires_at) WHERE status='RUNNING';
