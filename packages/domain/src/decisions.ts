import { DomainError } from "./errors.js";
import type { Id, JsonValue } from "./types.js";
import type {
  ContextChangeOperation,
  ProjectContext,
} from "./intent-context.js";

export type SourceArtifactType =
  | "pull_request"
  | "pull_request_review"
  | "pull_request_comment"
  | "issue_comment"
  | "design"
  | "work_item"
  | "ci"
  | "release"
  | "other";

export interface SourceArtifact {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly provider: string;
  readonly type: SourceArtifactType;
  readonly externalId: string;
  readonly title?: string;
  readonly url?: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly createdAt: string;
}

export type DecisionProposalStatus =
  | "DETECTED"
  | "READY_FOR_REVIEW"
  | "APPROVED"
  | "REJECTED";

export interface DecisionProposal {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly sourceArtifactId: Id;
  readonly sourceQuote?: string;
  readonly title: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly scope: readonly string[];
  readonly confidence?: number;
  readonly baseContextVersionId: Id;
  readonly status: DecisionProposalStatus;
  readonly detectedByPrincipalId: Id;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ContextChangeProposalStatus =
  | "GENERATING"
  | "READY_FOR_REVIEW"
  | "APPLYING"
  | "APPLIED"
  | "REJECTED"
  | "FAILED";

export interface ContextChangeProposal {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly decisionProposalId: Id;
  readonly baseContextVersionId: Id;
  readonly operations: readonly ContextChangeOperation[];
  readonly resultingContextPreview: ProjectContext;
  readonly status: ContextChangeProposalStatus;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DecisionStatus = "ACTIVE" | "SUPERSEDED";

export interface Decision {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly sourceDecisionProposalId: Id;
  readonly sourceArtifactId: Id;
  readonly title: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly scope: readonly string[];
  readonly status: DecisionStatus;
  readonly supersedesDecisionId?: Id;
  readonly supersededByDecisionId?: Id;
  readonly approvedByPrincipalId: Id;
  readonly createdAt: string;
  readonly supersededAt?: string;
}

export type ApprovalSubjectType =
  | "plan"
  | "work_items"
  | "design"
  | "decision_context_change"
  | "policy_exception"
  | "release";

export type ApprovalDecision = "APPROVED" | "REJECTED";

export interface Approval {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: Id;
  readonly decision: ApprovalDecision;
  readonly decidedByPrincipalId: Id;
  readonly expectedContextVersionId?: Id;
  readonly note?: string;
  readonly createdAt: string;
}

export type NotificationType =
  | "APPROVAL_REQUIRED"
  | "DECISION_DETECTED"
  | "CONTEXT_UPDATED"
  | "EXECUTION_REVIEW_REQUIRED"
  | "INTEGRATION_REQUIRED";

export interface Notification {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly recipientPrincipalId: Id;
  readonly type: NotificationType;
  readonly subjectType: string;
  readonly subjectId: Id;
  readonly title: string;
  readonly body: string;
  readonly readAt?: string;
  readonly createdAt: string;
}

const DECISION_PROPOSAL_TRANSITIONS: Record<
  DecisionProposalStatus,
  readonly DecisionProposalStatus[]
> = {
  DETECTED: ["READY_FOR_REVIEW", "REJECTED"],
  READY_FOR_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
};

const CONTEXT_CHANGE_PROPOSAL_TRANSITIONS: Record<
  ContextChangeProposalStatus,
  readonly ContextChangeProposalStatus[]
> = {
  GENERATING: ["READY_FOR_REVIEW", "FAILED"],
  READY_FOR_REVIEW: ["APPLYING", "REJECTED"],
  APPLYING: ["APPLIED", "FAILED"],
  APPLIED: [],
  REJECTED: [],
  FAILED: ["GENERATING"],
};

const DECISION_TRANSITIONS: Record<DecisionStatus, readonly DecisionStatus[]> = {
  ACTIVE: ["SUPERSEDED"],
  SUPERSEDED: [],
};

function transition<T extends string>(
  entity: string,
  allowed: Record<T, readonly T[]>,
  from: T,
  to: T,
): T {
  if (!allowed[from]?.includes(to)) {
    throw new DomainError(
      "invalid_transition",
      `${entity} cannot transition from ${from} to ${to}`,
    );
  }
  return to;
}

export function transitionDecisionProposal(
  from: DecisionProposalStatus,
  to: DecisionProposalStatus,
): DecisionProposalStatus {
  return transition("DecisionProposal", DECISION_PROPOSAL_TRANSITIONS, from, to);
}

export function transitionContextChangeProposal(
  from: ContextChangeProposalStatus,
  to: ContextChangeProposalStatus,
): ContextChangeProposalStatus {
  return transition(
    "ContextChangeProposal",
    CONTEXT_CHANGE_PROPOSAL_TRANSITIONS,
    from,
    to,
  );
}

export function transitionDecision(
  from: DecisionStatus,
  to: DecisionStatus,
): DecisionStatus {
  return transition("Decision", DECISION_TRANSITIONS, from, to);
}
