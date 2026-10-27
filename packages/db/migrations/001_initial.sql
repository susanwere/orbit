-- Orbit initial schema. Tenant isolation: organization_id on every tenant table.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  type TEXT NOT NULL CHECK (type IN ('human', 'agent', 'system', 'integration')),
  display_name TEXT NOT NULL,
  role TEXT CHECK (role IN ('admin', 'member', 'viewer')),
  identity_provider_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_principals_org ON principals (organization_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  alternatives JSONB NOT NULL DEFAULT '[]',
  scope JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'superseded', 'rejected', 'expired')),
  decided_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  affected_entity_refs JSONB NOT NULL DEFAULT '[]',
  supersedes_decision_id TEXT REFERENCES decisions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decisions_org_status ON decisions (organization_id, status);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('product', 'architecture', 'security', 'privacy', 'quality')),
  description TEXT NOT NULL,
  source_decision_id TEXT REFERENCES decisions(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  trigger_action TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('DENY', 'APPROVAL_REQUIRED')),
  mandatory BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
CREATE INDEX IF NOT EXISTS idx_policies_org_action ON policies (organization_id, trigger_action);

CREATE TABLE IF NOT EXISTS initiatives (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  team_id TEXT,
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  success_criteria JSONB NOT NULL DEFAULT '[]',
  non_goals JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('draft', 'planning', 'proposed', 'active', 'completed', 'archived')),
  dri_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_initiatives_org_status ON initiatives (organization_id, status);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  initiative_id TEXT NOT NULL REFERENCES initiatives(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  state TEXT NOT NULL CHECK (state IN ('draft', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled')),
  risk TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('low', 'medium', 'high')),
  external_ref TEXT,
  decision_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE INDEX IF NOT EXISTS idx_work_items_initiative ON work_items (initiative_id, state);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('PRODUCT', 'DESIGN', 'ENGINEERING', 'QA', 'RELEASE')),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'approved', 'running', 'paused', 'failed', 'completed', 'cancelled')),
  depends_on_workflow_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflows_work_item ON workflows (work_item_id, state);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'human', 'system', 'gate')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'running', 'waiting', 'blocked', 'failed', 'completed', 'skipped')),
  required_capabilities JSONB NOT NULL DEFAULT '[]',
  assigned_principal_id TEXT REFERENCES principals(id),
  assigned_agent_definition_id TEXT,
  depends_on_step_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_steps_workflow ON workflow_steps (workflow_id, state);

CREATE TABLE IF NOT EXISTS agent_definitions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]',
  approved_tools JSONB NOT NULL DEFAULT '[]',
  max_context_classification TEXT NOT NULL DEFAULT 'INTERNAL',
  allowed_context_scopes JSONB NOT NULL DEFAULT '[]',
  allowed_repositories JSONB NOT NULL DEFAULT '[]',
  allowed_paths JSONB NOT NULL DEFAULT '[]',
  approval_required_actions JSONB NOT NULL DEFAULT '[]',
  forbidden_actions JSONB NOT NULL DEFAULT '[]',
  network_policy TEXT NOT NULL DEFAULT 'none',
  network_allowlist JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'suspended', 'retired')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  workflow_step_id TEXT NOT NULL REFERENCES workflow_steps(id),
  mission TEXT NOT NULL,
  intent_excerpt TEXT NOT NULL DEFAULT '',
  items JSONB NOT NULL DEFAULT '[]',
  decision_ids JSONB NOT NULL DEFAULT '[]',
  max_classification TEXT NOT NULL DEFAULT 'PUBLIC',
  allowed_repositories JSONB NOT NULL DEFAULT '[]',
  allowed_paths JSONB NOT NULL DEFAULT '[]',
  forbidden_data JSONB NOT NULL DEFAULT '[]',
  approval_required_actions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution_contracts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  workflow_step_id TEXT NOT NULL REFERENCES workflow_steps(id),
  agent_definition_id TEXT NOT NULL REFERENCES agent_definitions(id),
  agent_definition_version INTEGER NOT NULL,
  context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id),
  allowed_actions JSONB NOT NULL DEFAULT '[]',
  approval_required_actions JSONB NOT NULL DEFAULT '[]',
  forbidden_actions JSONB NOT NULL DEFAULT '[]',
  allowed_repositories JSONB NOT NULL DEFAULT '[]',
  allowed_paths JSONB NOT NULL DEFAULT '[]',
  network_policy TEXT NOT NULL DEFAULT 'none',
  completion_criteria JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  agent_definition_id TEXT NOT NULL REFERENCES agent_definitions(id),
  agent_definition_version INTEGER NOT NULL,
  workflow_step_id TEXT NOT NULL REFERENCES workflow_steps(id),
  requested_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  human_owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  mission TEXT NOT NULL,
  context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id),
  execution_contract_id TEXT NOT NULL REFERENCES execution_contracts(id),
  state TEXT NOT NULL CHECK (state IN ('created', 'authorized', 'running', 'waiting', 'completed', 'failed', 'terminated')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS human_gates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  policy_id TEXT NOT NULL REFERENCES policies(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workflow_step_id TEXT REFERENCES workflow_steps(id),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_by_principal_id TEXT NOT NULL,
  approver_principal_id TEXT REFERENCES principals(id),
  state TEXT NOT NULL CHECK (state IN ('open', 'approved', 'rejected', 'expired')),
  blocked_workflow_ids JSONB NOT NULL DEFAULT '[]',
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gates_org_state ON human_gates (organization_id, state);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  scope_ref TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('passed', 'failed', 'pending', 'not_applicable')),
  summary TEXT NOT NULL DEFAULT '',
  artifact_ref TEXT,
  produced_by_principal_id TEXT,
  agent_session_id TEXT REFERENCES agent_sessions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_evaluations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  policy_id TEXT NOT NULL REFERENCES policies(id),
  policy_version INTEGER NOT NULL,
  action TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_org_time ON events (organization_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
