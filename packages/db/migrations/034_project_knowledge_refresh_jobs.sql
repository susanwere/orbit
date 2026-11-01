CREATE TABLE project_knowledge_refresh_jobs (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  repository_full_name text NOT NULL,
  merge_commit_sha text NOT NULL CHECK (merge_commit_sha ~ '^[0-9a-f]{40}$'),
  pull_number integer NOT NULL CHECK (pull_number > 0),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  generated_snapshot_id text REFERENCES project_knowledge_snapshots(id),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, repository_full_name, merge_commit_sha),
  FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,id)
);
CREATE INDEX idx_project_knowledge_refresh_jobs_due
  ON project_knowledge_refresh_jobs(status,next_attempt_at,created_at);

CREATE UNIQUE INDEX idx_knowledge_snapshot_refresh_job
  ON project_knowledge_snapshots(project_id, ((content->'origin'->>'jobId')))
  WHERE content->'origin'->>'jobId' IS NOT NULL;
