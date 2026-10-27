export type Id = string;

export type DataClassification =
  | "PUBLIC"
  | "INTERNAL"
  | "CONFIDENTIAL"
  | "RESTRICTED"
  | "SECRET";

export const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
  SECRET: 4,
};

export function exceedsClassification(
  value: DataClassification,
  max: DataClassification,
): boolean {
  return CLASSIFICATION_RANK[value] > CLASSIFICATION_RANK[max];
}

export type PrincipalType = "human" | "agent" | "system" | "integration";
export type OrganizationRole = "admin" | "member" | "viewer";

export interface Organization {
  id: Id;
  name: string;
  createdAt: string;
}

export interface Principal {
  id: Id;
  organizationId: Id;
  type: PrincipalType;
  displayName: string;
  role?: OrganizationRole;
  identityProviderId?: string;
}

export type DecisionStatus =
  | "proposed"
  | "active"
  | "superseded"
  | "rejected"
  | "expired";

export interface Decision {
  id: Id;
  organizationId: Id;
  title: string;
  rationale: string;
  alternatives: string[];
  scope: string[];
  status: DecisionStatus;
  decidedByPrincipalId: Id;
  affectedEntityRefs: string[];
  supersedesDecisionId?: Id;
  createdAt: string;
}

export type PolicyCategory =
  | "product"
  | "architecture"
  | "security"
  | "privacy"
  | "quality";

export type PolicyScopeType =
  | "platform"
  | "organization"
  | "team"
  | "initiative"
  | "work_item"
  | "workflow"
  | "step";

export type PolicyResult = "ALLOW" | "DENY" | "APPROVAL_REQUIRED";

export interface Policy {
  id: Id;
  organizationId: Id;
  code: string;
  name: string;
  category: PolicyCategory;
  description: string;
  sourceDecisionId?: Id;
  scopeType: PolicyScopeType;
  scopeId?: Id;
  /** Action identifier this policy governs, e.g. "api_contract.change". */
  triggerAction: string;
  result: Exclude<PolicyResult, "ALLOW">;
  mandatory: boolean;
  version: number;
  active: boolean;
}

export interface PolicyEvaluation {
  id: Id;
  organizationId: Id;
  policyId: Id;
  policyVersion: number;
  action: string;
  resourceRef: string;
  result: PolicyResult;
  reason: string;
  evaluatedAt: string;
}

export type InitiativeStatus =
  | "draft"
  | "planning"
  | "proposed"
  | "active"
  | "completed"
  | "archived";

export interface Initiative {
  id: Id;
  organizationId: Id;
  teamId?: Id;
  title: string;
  intent: string;
  successCriteria: string[];
  nonGoals: string[];
  status: InitiativeStatus;
  driPrincipalId: Id;
  createdAt: string;
}

export type WorkItemState =
  | "draft"
  | "ready"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled";

export type RiskLevel = "low" | "medium" | "high";

export interface WorkItem {
  id: Id;
  organizationId: Id;
  initiativeId: Id;
  /** Human-readable key, e.g. "CG-142". */
  key: string;
  title: string;
  description: string;
  ownerPrincipalId: Id;
  state: WorkItemState;
  risk: RiskLevel;
  externalRef?: string;
  decisionIds: Id[];
  createdAt: string;
}

export type WorkflowType =
  | "requirements"
  | "design"
  | "architecture"
  | "implementation"
  | "qa"
  | "review"
  | "release";

export type WorkflowState =
  | "proposed"
  | "approved"
  | "running"
  | "paused"
  | "failed"
  | "completed"
  | "cancelled";

export type StepKind = "ai" | "human" | "system" | "gate";
export type Lane = "PRODUCT" | "DESIGN" | "ENGINEERING" | "QA" | "RELEASE";

export type WorkflowStepState =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "blocked"
  | "failed"
  | "completed"
  | "skipped";

export interface Workflow {
  id: Id;
  organizationId: Id;
  workItemId: Id;
  type: WorkflowType;
  title: string;
  lane: Lane;
  state: WorkflowState;
  dependsOnWorkflowIds: Id[];
  createdAt: string;
}

export interface WorkflowStep {
  id: Id;
  organizationId: Id;
  workflowId: Id;
  title: string;
  kind: StepKind;
  state: WorkflowStepState;
  requiredCapabilities: string[];
  assignedPrincipalId?: Id;
  assignedAgentDefinitionId?: Id;
  dependsOnStepIds: Id[];
  createdAt: string;
}

export type AgentDefinitionStatus =
  | "draft"
  | "approved"
  | "suspended"
  | "retired";

export interface AgentDefinition {
  id: Id;
  organizationId: Id;
  name: string;
  purpose: string;
  provider: string;
  model: string;
  capabilities: string[];
  approvedTools: string[];
  maxContextClassification: DataClassification;
  allowedContextScopes: string[];
  allowedRepositories: string[];
  allowedPaths: string[];
  approvalRequiredActions: string[];
  forbiddenActions: string[];
  networkPolicy: "none" | "allowlist";
  networkAllowlist: string[];
  status: AgentDefinitionStatus;
  version: number;
  createdByPrincipalId: Id;
  createdAt: string;
}

export type AgentSessionState =
  | "created"
  | "authorized"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "terminated";

export interface AgentSession {
  id: Id;
  organizationId: Id;
  agentDefinitionId: Id;
  agentDefinitionVersion: number;
  workflowStepId: Id;
  requestedByPrincipalId: Id;
  humanOwnerPrincipalId: Id;
  mission: string;
  contextSnapshotId: Id;
  executionContractId: Id;
  state: AgentSessionState;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
}

export interface ContextSnapshotItem {
  contextItemId: Id;
  title: string;
  classification: DataClassification;
  excerpt: string;
}

export interface ContextSnapshot {
  id: Id;
  organizationId: Id;
  workflowStepId: Id;
  mission: string;
  intentExcerpt: string;
  items: ContextSnapshotItem[];
  decisionIds: Id[];
  /** Highest classification included; must not exceed the agent envelope. */
  maxClassification: DataClassification;
  allowedRepositories: string[];
  allowedPaths: string[];
  forbiddenData: string[];
  approvalRequiredActions: string[];
  createdAt: string;
}

export interface ExecutionContract {
  id: Id;
  organizationId: Id;
  workflowStepId: Id;
  agentDefinitionId: Id;
  agentDefinitionVersion: number;
  contextSnapshotId: Id;
  allowedActions: string[];
  approvalRequiredActions: string[];
  forbiddenActions: string[];
  allowedRepositories: string[];
  allowedPaths: string[];
  networkPolicy: "none" | "allowlist";
  completionCriteria: string[];
  createdAt: string;
}

export type HumanGateState = "open" | "approved" | "rejected" | "expired";

export interface HumanGate {
  id: Id;
  organizationId: Id;
  policyId: Id;
  workflowId: Id;
  workflowStepId?: Id;
  agentSessionId?: Id;
  title: string;
  reason: string;
  requestedByPrincipalId: Id;
  approverPrincipalId?: Id;
  state: HumanGateState;
  blockedWorkflowIds: Id[];
  decisionNote?: string;
  createdAt: string;
  resolvedAt?: string;
}

export type EvidenceCategory =
  | "test"
  | "requirement_coverage"
  | "design_verification"
  | "api_compatibility"
  | "security_check"
  | "human_review"
  | "policy_evaluation";

export type EvidenceResult = "passed" | "failed" | "pending" | "not_applicable";

export interface Evidence {
  id: Id;
  organizationId: Id;
  scopeRef: string;
  category: EvidenceCategory;
  title: string;
  result: EvidenceResult;
  summary: string;
  artifactRef?: string;
  producedByPrincipalId?: Id;
  agentSessionId?: Id;
  createdAt: string;
}

export interface OrbitEvent {
  id: Id;
  organizationId: Id;
  type: string;
  actorType: PrincipalType;
  actorId: Id;
  entityType: string;
  entityId: Id;
  payload: Record<string, unknown>;
  occurredAt: string;
}
