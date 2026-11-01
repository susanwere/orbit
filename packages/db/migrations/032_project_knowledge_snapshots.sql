CREATE TABLE IF NOT EXISTS project_knowledge_snapshots (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  content jsonb NOT NULL,
  created_by_principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,revision),
  FOREIGN KEY (project_id,organization_id) REFERENCES projects(id,organization_id),
  FOREIGN KEY (created_by_principal_id,organization_id) REFERENCES principals(id,organization_id)
);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_recent ON project_knowledge_snapshots(organization_id,project_id,revision DESC);
