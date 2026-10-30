-- ORB-80: authoritative, tenant-scoped workflow step executions.
-- A plan approval alone does not grant execution or satisfy step gates.
CREATE TABLE workflow_step_executions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  work_item_key TEXT NOT NULL,
  workflow_index INTEGER NOT NULL CHECK (workflow_index >= 0),
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  state TEXT NOT NULL DEFAULT 'BLOCKED'
    CHECK (state IN ('BLOCKED','READY','RUNNING','WAITING','COMPLETED','FAILED','CANCELED')),
  approval_required BOOLEAN NOT NULL,
  approved_by_principal_id TEXT,
  approved_at TIMESTAMPTZ,
  agent_session_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, plan_id, work_item_key, workflow_index, step_index),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id),
  FOREIGN KEY (project_id, plan_id)
    REFERENCES plan_proposals(project_id, id),
  FOREIGN KEY (organization_id, approved_by_principal_id)
    REFERENCES principals(organization_id, id),
  FOREIGN KEY (project_id, agent_session_id)
    REFERENCES agent_sessions(project_id, id),
  CHECK ((approved_by_principal_id IS NULL AND approved_at IS NULL)
    OR (approved_by_principal_id IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE workflow_step_prerequisites (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  prerequisite_step_id TEXT NOT NULL,
  PRIMARY KEY (project_id, step_id, prerequisite_step_id),
  CHECK (step_id <> prerequisite_step_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id),
  FOREIGN KEY (project_id, step_id)
    REFERENCES workflow_step_executions(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, prerequisite_step_id)
    REFERENCES workflow_step_executions(project_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_workflow_step_pending ON workflow_step_executions
  (organization_id, project_id, state);
CREATE INDEX idx_workflow_step_downstream ON workflow_step_prerequisites
  (project_id, prerequisite_step_id);

-- The graph must be assembled server-side from the approved immutable plan.
-- No browser request may self-declare a prerequisite complete or self-approve a gate.
