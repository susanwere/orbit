export type Id = string;

export type PrincipalType = "human" | "agent" | "system" | "integration";
export type OrganizationRole = "admin" | "member" | "viewer";

export interface Principal {
  id: Id;
  organizationId: Id;
  type: PrincipalType;
  displayName: string;
  role?: OrganizationRole;
}

export type DataClassification =
  | "PUBLIC"
  | "INTERNAL"
  | "CONFIDENTIAL"
  | "RESTRICTED";

const CLASSIFICATION_ORDER: Record<DataClassification, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
};

export function exceedsClassification(
  value: DataClassification,
  maximum: DataClassification,
): boolean {
  return CLASSIFICATION_ORDER[value] > CLASSIFICATION_ORDER[maximum];
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

export interface ContextSnapshotItem {
  contextItemId: Id;
  title: string;
  classification: DataClassification;
  excerpt: string;
}

export interface ContextSnapshot {
  id: Id;
  organizationId: Id;
  sourceContextVersionId?: Id;
  mission: string;
  items: ContextSnapshotItem[];
  maxClassification: DataClassification;
  allowedRepositories: string[];
  allowedPaths: string[];
  forbiddenData: string[];
  approvalRequiredActions: string[];
  createdAt: string;
}

export type PolicyResult = "ALLOW" | "APPROVAL_REQUIRED" | "DENY";

export interface Policy {
  id: Id;
  organizationId: Id;
  code: string;
  name: string;
  category: "product" | "architecture" | "security" | "privacy" | "quality";
  description: string;
  scopeType: string;
  scopeId?: Id;
  triggerAction: string;
  result: Exclude<PolicyResult, "ALLOW">;
  mandatory: boolean;
  version: number;
  active: boolean;
  createdAt: string;
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
