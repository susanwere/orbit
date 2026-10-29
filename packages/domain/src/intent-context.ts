import type { Id, JsonValue } from "./types.js";

export interface Intent {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly statement: string;
  readonly createdByPrincipalId: Id;
  readonly createdAt: string;
}

export interface ContextConstraint {
  readonly id: Id;
  readonly key: string;
  readonly statement: string;
  readonly sourceDecisionId: Id;
  readonly createdAt: string;
}

/**
 * A constraint visible in a proposal preview before the authoritative Decision
 * exists. Approval materializes it into ContextConstraint with sourceDecisionId.
 */
export interface ProposedContextConstraint {
  readonly id: Id;
  readonly key: string;
  readonly statement: string;
  readonly sourceDecisionProposalId: Id;
  readonly createdAt: string;
}

export type ContextConstraintPreview = ContextConstraint | ProposedContextConstraint;

export interface ProjectContext {
  readonly projectId: Id;
  readonly originalIntentId: Id;
  /**
   * A derived interpretation of the project's current intent.
   * The original Intent entity is never rewritten.
   */
  readonly currentIntent: string;
  readonly constraints: readonly ContextConstraint[];
  readonly attributes: Readonly<Record<string, JsonValue>>;
}

export interface ProjectContextPreview {
  readonly projectId: Id;
  readonly originalIntentId: Id;
  readonly currentIntent: string;
  readonly constraints: readonly ContextConstraintPreview[];
  readonly attributes: Readonly<Record<string, JsonValue>>;
}

export interface ContextVersion {
  readonly id: Id;
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly versionNumber: number;
  readonly parentContextVersionId?: Id;
  readonly content: ProjectContext;
  readonly contentHash: string;
  readonly createdFromDecisionId?: Id;
  readonly createdAt: string;
}

export interface ProjectContextHead {
  readonly organizationId: Id;
  readonly projectId: Id;
  readonly currentContextVersionId: Id;
  readonly versionNumber: number;
  readonly updatedAt: string;
}

export type ContextChangeOperation =
  | {
      readonly op: "add" | "replace";
      readonly path: string;
      readonly value: JsonValue;
    }
  | {
      readonly op: "remove";
      readonly path: string;
    };
