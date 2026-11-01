-- CI observation is distinct from merged-PR completion evidence.
ALTER TABLE muse_execution_jobs
  ADD COLUMN github_ci_state TEXT CHECK (github_ci_state IN ('WAITING','PENDING','FAILED','PASSED')),
  ADD COLUMN github_ci_report JSONB,
  ADD COLUMN github_ci_checked_at TIMESTAMPTZ,
  ADD COLUMN github_review_state TEXT CHECK (github_review_state IN ('DRAFT','READY','ERROR')),
  ADD COLUMN github_review_error TEXT,
  ADD COLUMN repair_source_job_id TEXT;
-- Lineage is resolved with tenant/project/step joins. No circular session/job foreign key.
ALTER TABLE agent_sessions ADD COLUMN repair_source_job_id TEXT;
