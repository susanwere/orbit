import { DomainError } from "./errors.js";
import type { DataClassification, Id } from "./types.js";

export interface AuthorizationBasis {
  readonly requestedByPrincipalId: Id;
  readonly agentDefinitionId: Id;
  readonly agentDefinitionVersion: number;
  readonly capabilities: readonly string[];
  readonly policyEvaluationIds: readonly Id[];
}

export interface ContextSnapshotItem {
  readonly contextItemId: Id;
  readonly title: string;
  readonly classification: DataClassification;
  readonly excerpt: string;
  readonly sourceRef?: string;
}

export interface ContextSnapshot {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly sourceContextVersionId: Id;
  readonly mission: string;
  readonly items: readonly ContextSnapshotItem[];
  readonly includedDecisionIds: readonly Id[];
  readonly includedConstraintIds: readonly Id[];
  readonly includedPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly authorizationBasis: AuthorizationBasis;
  readonly maxClassification: DataClassification;
  readonly allowedRepositories: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly forbiddenData: readonly string[];
  readonly approvalRequiredActions: readonly string[];
  readonly createdAt: string;
}

export type AgentSessionState =
  | "CREATED"
  | "AUTHORIZED"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "TERMINATED";

export interface AgentSession {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly agentDefinitionId: Id;
  readonly agentDefinitionVersion: number;
  readonly workItemId: Id;
  readonly requestedByPrincipalId: Id;
  readonly humanOwnerPrincipalId: Id;
  readonly mission: string;
  readonly contextSnapshotId: Id;
  readonly executionContractId: Id;
  readonly state: AgentSessionState;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly createdAt: string;
}

const AGENT_SESSION_TRANSITIONS: Record<
  AgentSessionState,
  readonly AgentSessionState[]
> = {
  CREATED: ["AUTHORIZED", "TERMINATED"],
  AUTHORIZED: ["RUNNING", "TERMINATED"],
  RUNNING: ["WAITING", "COMPLETED", "FAILED", "TERMINATED"],
  WAITING: ["RUNNING", "FAILED", "TERMINATED"],
  COMPLETED: [],
  FAILED: [],
  TERMINATED: [],
};

export function transitionAgentSession(
  from: AgentSessionState,
  to: AgentSessionState,
): AgentSessionState {
  if (!AGENT_SESSION_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      "invalid_transition",
      `AgentSession cannot transition from ${from} to ${to}`,
    );
  }
  return to;
}
