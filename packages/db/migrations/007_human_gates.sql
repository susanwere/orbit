CREATE TABLE human_gates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  assigned_human_principal_id TEXT NOT NULL REFERENCES principals(id),
  trigger_context_version_id TEXT NOT NULL REFERENCES context_versions(id),
  reason TEXT NOT NULL,
  affected_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN
    ('OPEN','APPROVED','REJECTED','ALTERNATIVE_REQUESTED')),
  resolved_by_principal_id TEXT REFERENCES principals(id),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id,agent_session_id,trigger_context_version_id)
);
CREATE INDEX idx_human_gates_attention ON human_gates(project_id,assigned_human_principal_id,created_at DESC)
  WHERE status='OPEN';
