CREATE TABLE orbit_work_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(btrim(title))>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id,id)
);
CREATE TABLE orbit_agent_definition_versions (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version>0),
  status TEXT NOT NULL CHECK(status IN ('draft','approved','suspended','retired')),
  definition JSONB NOT NULL,
  approved_by_principal_id TEXT REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id,version)
);
CREATE INDEX idx_orbit_approved_agent_definitions
  ON orbit_agent_definition_versions(organization_id,id,version DESC) WHERE status='approved';
