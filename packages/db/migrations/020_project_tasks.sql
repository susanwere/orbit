-- Flat, editable task prompts reuse the existing execution engine and immutable snapshots.
CREATE TABLE project_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  prompt TEXT NOT NULL CHECK(length(btrim(prompt)) BETWEEN 1 AND 4000),
  request_prompt TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  approved_revision INTEGER,
  approved_by_principal_id TEXT REFERENCES principals(id),
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','STARTING','ACTIVE','NEEDS_INPUT','IN_REVIEW','DONE','FAILED')),
  dependency_keys JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(dependency_keys)='array'),
  step_id TEXT,
  session_id TEXT,
  source_job_id TEXT,
  github_authorized BOOLEAN NOT NULL DEFAULT false,
  automatic_repairs INTEGER NOT NULL DEFAULT 0 CHECK(automatic_repairs BETWEEN 0 AND 3),
  last_error TEXT,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id,id),
  UNIQUE(project_id,task_key),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,id),
  FOREIGN KEY(project_id,plan_id) REFERENCES plan_proposals(project_id,id)
);
ALTER TABLE workflow_step_executions ADD COLUMN task_id TEXT,
  ADD COLUMN task_prompt_revision INTEGER,
  ADD CONSTRAINT workflow_step_task_reference FOREIGN KEY(project_id,task_id) REFERENCES project_tasks(project_id,id);
CREATE INDEX project_tasks_project_order ON project_tasks(project_id,created_at,id);
