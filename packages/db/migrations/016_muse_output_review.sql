-- Preserve only bounded reviewable final text, never raw provider/tool transcripts.
CREATE TABLE muse_job_outputs (
  job_id TEXT PRIMARY KEY REFERENCES muse_execution_jobs(id),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(btrim(content)) > 0 AND length(content) <= 20000),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  changed_paths JSONB NOT NULL CHECK (jsonb_typeof(changed_paths) = 'array'),
  source TEXT NOT NULL CHECK (source IN ('execution','read_only_recovery')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,id)
);

-- Default remains CI. Only an authenticated administrator can explicitly
-- designate a no-code proposal for human review; never infer this from model text.
ALTER TABLE workflow_step_executions ADD COLUMN completion_kind TEXT NOT NULL DEFAULT 'github_ci'
  CHECK (completion_kind IN ('github_ci','human_review'));
