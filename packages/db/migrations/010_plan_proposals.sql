-- ORB-73: one reviewable plan per project; original intent remains immutable.
-- A failed generation can be retried. A human-approved plan is immutable.
CREATE TABLE plan_proposals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('GENERATING', 'FAILED', 'READY_FOR_REVIEW', 'APPROVED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  content JSONB,
  failure_reason TEXT,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  approved_by_principal_id TEXT REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id),
  UNIQUE (project_id, id),
  CHECK ((status IN ('READY_FOR_REVIEW', 'APPROVED') AND content IS NOT NULL)
    OR (status IN ('GENERATING', 'FAILED') AND content IS NULL))
);
CREATE INDEX idx_plan_proposals_organization ON plan_proposals (organization_id, project_id);
