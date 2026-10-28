import {
  DomainError,
  type ContextChangeProposal,
  type ContextVersion,
} from "@orbit/domain";
import { serializeCanonicalJson } from "./canonical-context.js";
import { buildContextChangeRevision } from "./context-change-generator.js";

export interface RebaseContextChangeInput {
  readonly previous: ContextChangeProposal;
  readonly previousBase: ContextVersion;
  readonly current: ContextVersion;
  readonly id: string;
  readonly createdAt: string;
}

/**
 * A rebase is always a NEW proposal revision, never an approval.
 * V1 safely carries forward append-only decisions. Other edits require a
 * human to resolve the conflict against the latest context.
 */
export function rebaseContextChangeProposal(
  input: RebaseContextChangeInput,
): ContextChangeProposal {
  const { previous, previousBase, current } = input;
  if (
    previous.projectId !== current.projectId ||
    previous.projectId !== previousBase.projectId ||
    previous.organizationId !== current.organizationId ||
    previous.organizationId !== previousBase.organizationId ||
    previous.baseContextVersionId !== previousBase.id
  ) {
    throw new DomainError("project_mismatch", "Proposal and context versions must share a scope and base.");
  }
  if (previous.status !== "READY_FOR_REVIEW") {
    throw new DomainError("invalid_state", "Only reviewable proposals can be rebased.");
  }
  if (current.versionNumber <= previousBase.versionNumber) {
    throw new DomainError("invalid_state", "Rebase requires a newer context version.");
  }
  if (
    current.content.projectId !== previousBase.content.projectId ||
    current.content.originalIntentId !== previousBase.content.originalIntentId
  ) {
    throw new DomainError("immutable_context_path", "Context identity changed.");
  }

  const appendOnly = previous.operations.every(
    (operation) => operation.op === "add" && operation.path === "/constraints/-",
  );
  if (
    !appendOnly &&
    serializeCanonicalJson(previousBase.content) !==
      serializeCanonicalJson(current.content)
  ) {
    throw new DomainError(
      "stale_context_version",
      "Non-append operations require manual conflict resolution.",
    );
  }

  const existingKeys = new Set(current.content.constraints.map((constraint) => constraint.key));
  for (const operation of previous.operations) {
    if (operation.op !== "add" || operation.path !== "/constraints/-") continue;
    const value = operation.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DomainError("validation", "Constraint append must contain an object.");
    }
    const key = (value as Record<string, unknown>).key;
    if (typeof key !== "string" || existingKeys.has(key)) {
      throw new DomainError("stale_context_version", "Proposed constraint conflicts with current context.");
    }
    existingKeys.add(key);
  }

  return buildContextChangeRevision({
    id: input.id,
    organizationId: previous.organizationId,
    projectId: previous.projectId,
    decisionProposalId: previous.decisionProposalId,
    baseContextVersion: current,
    operations: previous.operations,
    revision: previous.revision + 1,
    createdAt: input.createdAt,
  });
}
