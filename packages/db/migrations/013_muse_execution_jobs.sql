-- Muse Code invocation is an auditable job, not an implicit plan approval effect.
CREATE TABLE muse_execution_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  workflow_step_id TEXT NOT NULL,
  requested_by_principal_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','RUNNING','TURN_FINISHED','FAILED','REVIEW_REQUIRED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  exit_code INTEGER,
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE(project_id, agent_session_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id),
  FOREIGN KEY (project_id, agent_session_id) REFERENCES agent_sessions(project_id, id),
  FOREIGN KEY (project_id, workflow_step_id) REFERENCES workflow_step_executions(project_id, id),
  FOREIGN KEY (organization_id, requested_by_principal_id)
    REFERENCES principals(organization_id, id)
);
CREATE INDEX idx_muse_execution_jobs_ready ON muse_execution_jobs(created_at)
  WHERE status='QUEUED';
