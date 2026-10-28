import {
  DomainError,
  type ContextChangeOperation,
  type ContextChangeProposal,
  type ContextVersion,
} from "@orbit/domain";
import type { DecisionCandidate } from "../decisions/decision-detector.js";
import {
  applyContextChangeOperations,
  asJsonValue,
} from "./context-mutation.js";

export const DEFAULT_PROPOSAL_ALLOWED_PATHS = [
  "/constraints/-",
  "/currentIntent",
  "/attributes/**",
] as const;

export interface GenerateContextChangeProposalInput {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly decisionProposalId: string;
  readonly baseContextVersion: ContextVersion;
  readonly candidate: DecisionCandidate;
  readonly createdAt: string;
  readonly revision?: number;
  readonly allowedPaths?: readonly string[];
}

function stableConstraintId(decisionProposalId: string): string {
  return `constraint_proposed_${decisionProposalId}`;
}

function decisionConstraintOperation(
  input: GenerateContextChangeProposalInput,
): ContextChangeOperation {
  return {
    op: "add",
    path: "/constraints/-",
    value: asJsonValue({
      id: stableConstraintId(input.decisionProposalId),
      key: `decision.${input.decisionProposalId}`,
      statement: input.candidate.title,
      sourceDecisionProposalId: input.decisionProposalId,
      createdAt: input.createdAt,
    }),
  };
}

/**
 * Deterministically turns a grounded decision candidate into a reviewable
 * context mutation. The model does not choose mutation paths or mutate current
 * context; it only supplies the interpreted decision candidate.
 */
export function generateContextChangeProposal(
  input: GenerateContextChangeProposalInput,
): ContextChangeProposal {
  if (input.baseContextVersion.projectId !== input.projectId) {
    throw new DomainError(
      "project_mismatch",
      "Base ContextVersion belongs to another project.",
    );
  }

  if (input.baseContextVersion.organizationId !== input.organizationId) {
    throw new DomainError(
      "organization_mismatch",
      "Base ContextVersion belongs to another organization.",
    );
  }

  if (!input.candidate.title.trim()) {
    throw new DomainError(
      "invalid_decision_candidate",
      "Decision candidate title is required.",
    );
  }

  const operations = [decisionConstraintOperation(input)];
  const allowedPaths = input.allowedPaths ?? DEFAULT_PROPOSAL_ALLOWED_PATHS;
  const preview = applyContextChangeOperations(
    input.baseContextVersion.content,
    operations,
    allowedPaths,
  );

  return {
    id: input.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    decisionProposalId: input.decisionProposalId,
    baseContextVersionId: input.baseContextVersion.id,
    revision: input.revision ?? 1,
    operations,
    resultingContextPreview: preview,
    status: "READY_FOR_REVIEW",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}
