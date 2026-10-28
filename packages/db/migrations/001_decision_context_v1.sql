-- ORB-6: Decision and Context persistence model (V1)
-- Tenant-owned tables carry organization_id and project_id where relevant.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  repository_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE INDEX idx_projects_organization ON projects (organization_id);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('human', 'agent', 'system', 'integration')),
  display_name TEXT NOT NULL,
  role TEXT CHECK (role IN ('admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_principals_organization ON principals (organization_id);

CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  statement TEXT NOT NULL CHECK (length(btrim(statement)) > 0),
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id)
);

CREATE TABLE source_artifacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  type TEXT NOT NULL CHECK (
    type IN (
      'pull_request',
      'pull_request_review',
      'pull_request_comment',
      'issue_comment',
      'design',
      'work_item',
      'ci',
      'release',
      'other'
    )
  ),
  external_id TEXT NOT NULL,
  title TEXT,
  url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, provider, type, external_id),
  UNIQUE (project_id, id)
);
CREATE INDEX idx_source_artifacts_project ON source_artifacts (project_id, created_at DESC);

CREATE TABLE webhook_inbox (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (
    status IN ('received', 'processing', 'processed', 'ignored', 'failed')
  ),
  failure_reason TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, delivery_id)
);
CREATE INDEX idx_webhook_inbox_status ON webhook_inbox (status, received_at);
CREATE INDEX idx_webhook_inbox_project ON webhook_inbox (project_id, received_at DESC);

CREATE TABLE context_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  parent_context_version_id TEXT REFERENCES context_versions(id),
  content JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_from_decision_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version_number),
  UNIQUE (project_id, content_hash),
  UNIQUE (project_id, id)
);
CREATE INDEX idx_context_versions_project_history
  ON context_versions (project_id, version_number DESC);

CREATE TABLE project_context_heads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  current_context_version_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, current_context_version_id),
  FOREIGN KEY (project_id, current_context_version_id)
    REFERENCES context_versions(project_id, id)
);

CREATE TABLE decision_proposals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_artifact_id TEXT NOT NULL,
  source_quote TEXT,
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  rationale TEXT NOT NULL DEFAULT '',
  alternatives JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  base_context_version_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('DETECTED', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED')
  ),
  detected_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_artifact_id, fingerprint),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, source_artifact_id)
    REFERENCES source_artifacts(project_id, id),
  FOREIGN KEY (project_id, base_context_version_id)
    REFERENCES context_versions(project_id, id)
);
CREATE INDEX idx_decision_proposals_review
  ON decision_proposals (project_id, status, created_at DESC);

CREATE TABLE context_change_proposals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision_proposal_id TEXT NOT NULL,
  base_context_version_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  operations JSONB NOT NULL DEFAULT '[]'::jsonb,
  resulting_context_preview JSONB NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'GENERATING',
      'READY_FOR_REVIEW',
      'APPLYING',
      'APPLIED',
      'REJECTED',
      'FAILED'
    )
  ),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (decision_proposal_id, revision),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, decision_proposal_id)
    REFERENCES decision_proposals(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, base_context_version_id)
    REFERENCES context_versions(project_id, id)
);
CREATE INDEX idx_context_change_proposals_review
  ON context_change_proposals (project_id, status, created_at DESC);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (
    subject_type IN (
      'plan',
      'work_items',
      'design',
      'decision_context_change',
      'policy_exception',
      'release'
    )
  ),
  subject_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  decided_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  expected_context_version_id TEXT,
  decision_proposal_id TEXT,
  context_change_proposal_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, expected_context_version_id)
    REFERENCES context_versions(project_id, id),
  FOREIGN KEY (project_id, decision_proposal_id)
    REFERENCES decision_proposals(project_id, id),
  FOREIGN KEY (project_id, context_change_proposal_id)
    REFERENCES context_change_proposals(project_id, id)
);
CREATE INDEX idx_approvals_project_subject
  ON approvals (project_id, subject_type, subject_id, created_at DESC);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_decision_proposal_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  rationale TEXT NOT NULL DEFAULT '',
  alternatives JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  supersedes_decision_id TEXT,
  superseded_by_decision_id TEXT,
  approved_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,
  CHECK (
    (status = 'ACTIVE' AND superseded_at IS NULL)
    OR
    (status = 'SUPERSEDED' AND superseded_at IS NOT NULL)
  ),
  UNIQUE (source_decision_proposal_id),
  UNIQUE (approval_id),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, source_decision_proposal_id)
    REFERENCES decision_proposals(project_id, id),
  FOREIGN KEY (project_id, source_artifact_id)
    REFERENCES source_artifacts(project_id, id),
  FOREIGN KEY (project_id, approval_id)
    REFERENCES approvals(project_id, id),
  FOREIGN KEY (project_id, supersedes_decision_id)
    REFERENCES decisions(project_id, id),
  FOREIGN KEY (project_id, superseded_by_decision_id)
    REFERENCES decisions(project_id, id)
);
CREATE INDEX idx_decisions_project_status ON decisions (project_id, status, created_at DESC);

ALTER TABLE context_versions
  ADD CONSTRAINT fk_context_versions_created_from_decision
  FOREIGN KEY (project_id, created_from_decision_id)
  REFERENCES decisions(project_id, id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recipient_principal_id TEXT NOT NULL REFERENCES principals(id),
  type TEXT NOT NULL CHECK (
    type IN (
      'APPROVAL_REQUIRED',
      'DECISION_DETECTED',
      'CONTEXT_UPDATED',
      'EXECUTION_REVIEW_REQUIRED',
      'INTEGRATION_REQUIRED'
    )
  ),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_recipient_unread
  ON notifications (recipient_principal_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system', 'integration')),
  actor_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_project_time ON events (project_id, occurred_at DESC);
CREATE INDEX idx_events_correlation ON events (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE context_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_context_version_id TEXT NOT NULL,
  mission TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  included_decision_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  included_constraint_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  included_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  excluded_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  authorization_basis JSONB NOT NULL,
  max_classification TEXT NOT NULL CHECK (
    max_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')
  ),
  allowed_repositories JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  forbidden_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_required_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, source_context_version_id)
    REFERENCES context_versions(project_id, id)
);
CREATE INDEX idx_context_snapshots_project_version
  ON context_snapshots (project_id, source_context_version_id, created_at DESC);

CREATE TABLE execution_contracts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  context_snapshot_id TEXT NOT NULL,
  agent_definition_id TEXT NOT NULL,
  agent_definition_version INTEGER NOT NULL CHECK (agent_definition_version > 0),
  allowed_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_required_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  forbidden_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_repositories JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  network_policy TEXT NOT NULL CHECK (network_policy IN ('none', 'allowlist')),
  network_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
  completion_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, context_snapshot_id)
    REFERENCES context_snapshots(project_id, id)
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_definition_id TEXT NOT NULL,
  agent_definition_version INTEGER NOT NULL CHECK (agent_definition_version > 0),
  work_item_id TEXT NOT NULL,
  requested_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  human_owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  mission TEXT NOT NULL,
  context_snapshot_id TEXT NOT NULL,
  execution_contract_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'CREATED',
      'AUTHORIZED',
      'RUNNING',
      'WAITING',
      'COMPLETED',
      'FAILED',
      'TERMINATED'
    )
  ),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, context_snapshot_id)
    REFERENCES context_snapshots(project_id, id),
  FOREIGN KEY (project_id, execution_contract_id)
    REFERENCES execution_contracts(project_id, id)
);
CREATE INDEX idx_agent_sessions_project_state
  ON agent_sessions (project_id, state, created_at DESC);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  category TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('PASSED', 'FAILED', 'PENDING', 'NOT_APPLICABLE')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  artifact_ref TEXT,
  produced_by_principal_id TEXT,
  agent_session_id TEXT REFERENCES agent_sessions(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidence_scope ON evidence (project_id, scope_type, scope_id, created_at DESC);

-- Immutable historical records may be deleted by tenant cleanup/cascades, but
-- application code cannot rewrite their contents in place.
CREATE OR REPLACE FUNCTION orbit_prevent_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable and cannot be updated', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER intents_immutable
  BEFORE UPDATE ON intents
  FOR EACH ROW EXECUTE FUNCTION orbit_prevent_update();

CREATE TRIGGER source_artifacts_immutable
  BEFORE UPDATE ON source_artifacts
  FOR EACH ROW EXECUTE FUNCTION orbit_prevent_update();

CREATE TRIGGER context_versions_immutable
  BEFORE UPDATE ON context_versions
  FOR EACH ROW EXECUTE FUNCTION orbit_prevent_update();

CREATE TRIGGER approvals_immutable
  BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION orbit_prevent_update();

CREATE TRIGGER events_immutable
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION orbit_prevent_update();

CREATE TRIGGER context_snapshots_immutable
  BEFORE UPDATE ON context_snapshots
  FOR EACH ROW EXECUTE FUNCTION orbit_prevent_update();

CREATE TRIGGER execution_contracts_immutable
  BEFORE UPDATE ON execution_contracts
  FOR EACH ROW EXECUTE FUNCTION orbit_prevent_update();
