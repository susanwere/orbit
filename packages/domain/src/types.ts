export type Id = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type PrincipalType = "human" | "agent" | "system" | "integration";
export type OrganizationRole = "admin" | "member" | "viewer";

export interface Principal {
  readonly id: Id;
  readonly organizationId: Id;
  readonly type: PrincipalType;
  readonly displayName: string;
  readonly role?: OrganizationRole;
}

export type DataClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

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

export type AgentDefinitionStatus = "draft" | "approved" | "suspended" | "retired";

export interface AgentDefinition {
  readonly id: Id;
  readonly organizationId: Id;
  readonly name: string;
  readonly purpose: string;
  readonly provider: string;
  readonly model: string;
  readonly capabilities: readonly string[];
  readonly approvedTools: readonly string[];
  readonly maxContextClassification: DataClassification;
  readonly allowedContextScopes: readonly string[];
  readonly allowedRepositories: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly approvalRequiredActions: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly networkPolicy: "none" | "allowlist";
  readonly networkAllowlist: readonly string[];
  readonly status: AgentDefinitionStatus;
  readonly version: number;
  readonly createdByPrincipalId: Id;
  readonly createdAt: string;
}

export type PolicyResult = "ALLOW" | "APPROVAL_REQUIRED" | "DENY";

export interface Policy {
  readonly id: Id;
  readonly organizationId: Id;
  readonly code: string;
  readonly name: string;
  readonly category: "product" | "architecture" | "security" | "privacy" | "quality";
  readonly description: string;
  readonly scopeType: string;
  readonly scopeId?: Id;
  readonly triggerAction: string;
  readonly result: Exclude<PolicyResult, "ALLOW">;
  readonly mandatory: boolean;
  readonly version: number;
  readonly active: boolean;
  readonly createdAt: string;
}

export interface PolicyEvaluation {
  readonly id: Id;
  readonly organizationId: Id;
  readonly policyId: Id;
  readonly policyVersion: number;
  readonly action: string;
  readonly resourceRef: string;
  readonly result: PolicyResult;
  readonly reason: string;
  readonly evaluatedAt: string;
}
