import {
  DomainError,
  type ContextConstraint,
  type ContextConstraintPreview,
  type ProjectContext,
  type ProjectContextPreview,
} from "@orbit/domain";
import type { SqlDatabase, SqlExecutor } from "@orbit/db";
import { randomUUID } from "node:crypto";
import { hashProjectContext } from "../context/canonical-context.js";
import type {
  DecisionPromotionPort,
  PromoteDecisionInput,
  PromoteDecisionResult,
} from "./decision-promotion-port.js";
import type {
  CommittedDomainEvent,
  DomainEventPublisher,
} from "../events/domain-event-publisher.js";

interface HeadRow extends Record<string, unknown> {
  organization_id: string;
  project_id: string;
  current_context_version_id: string;
  version_number: number;
}

interface DecisionProposalRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  source_artifact_id: string;
  title: string;
  rationale: string;
  alternatives: string[];
  scope: string[];
  base_context_version_id: string;
  status: string;
}

interface ContextChangeProposalRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  decision_proposal_id: string;
  base_context_version_id: string;
  revision: number;
  resulting_context_preview: ProjectContextPreview;
  status: string;
}

export type PromotionIdKind =
  | "approval"
  | "decision"
  | "context"
  | "event";

export type PromotionIdFactory = (kind: PromotionIdKind) => string;

const defaultIdFactory: PromotionIdFactory = (kind) =>
  `${kind}_${randomUUID()}`;

function isProposedConstraint(
  constraint: ContextConstraintPreview,
): constraint is Extract<
  ContextConstraintPreview,
  { readonly sourceDecisionProposalId: string }
> {
  return "sourceDecisionProposalId" in constraint;
}

export function materializeApprovedContext(
  preview: ProjectContextPreview,
  decisionProposalId: string,
  decisionId: string,
): ProjectContext {
  const constraints: ContextConstraint[] = preview.constraints.map((constraint) => {
    if (!isProposedConstraint(constraint)) return constraint;

    if (constraint.sourceDecisionProposalId !== decisionProposalId) {
      throw new DomainError(
        "invalid_context_preview",
        "Context preview contains a proposed constraint from another DecisionProposal.",
      );
    }

    return {
      id: constraint.id,
      key: constraint.key,
      statement: constraint.statement,
      sourceDecisionId: decisionId,
      createdAt: constraint.createdAt,
    };
  });

  return {
    projectId: preview.projectId,
    originalIntentId: preview.originalIntentId,
    currentIntent: preview.currentIntent,
    constraints,
    attributes: preview.attributes,
  };
}

export class PostgresDecisionPromotion implements DecisionPromotionPort {
  constructor(
    private readonly database: SqlDatabase,
    private readonly publisher: DomainEventPublisher,
    private readonly idFactory: PromotionIdFactory = defaultIdFactory,
  ) {}

  async promote(input: PromoteDecisionInput): Promise<PromoteDecisionResult> {
    const committed = await this.database.transaction(async (transaction) =>
      this.promoteInsideTransaction(transaction, input),
    );

    // Publishing is intentionally after commit. Consumers can always recover
    // from the durable events table if a live publish fails.
    await this.publisher.publish(committed.events);
    return committed.result;
  }

  private async promoteInsideTransaction(
    transaction: SqlExecutor,
    input: PromoteDecisionInput,
  ): Promise<{
    result: PromoteDecisionResult;
    events: readonly CommittedDomainEvent[];
  }> {
    await transaction.query<Record<string, never>>(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [input.projectId],
    );

    const headResult = await transaction.query<HeadRow>(
      `SELECT organization_id, project_id, current_context_version_id, version_number
       FROM project_context_heads
       WHERE project_id = $1
       FOR UPDATE`,
      [input.projectId],
    );
    const head = headResult.rows[0];
    if (!head) {
      throw new DomainError("not_found", "Project context head not found.");
    }
    if (
      head.organization_id !== input.organizationId ||
      head.current_context_version_id !== input.expectedContextVersionId
    ) {
      throw new DomainError(
        "stale_context_version",
        "Project context advanced before approval could be committed.",
      );
    }

    const decisionResult = await transaction.query<DecisionProposalRow>(
      `SELECT
         id, organization_id, project_id, source_artifact_id, title, rationale,
         alternatives, scope, base_context_version_id, status
       FROM decision_proposals
       WHERE project_id = $1 AND id = $2
       FOR UPDATE`,
      [input.projectId, input.decisionProposalId],
    );
    const proposal = decisionResult.rows[0];
    if (!proposal) throw new DomainError("not_found", "Decision proposal not found.");

    const changeResult = await transaction.query<ContextChangeProposalRow>(
      `SELECT
         id, organization_id, project_id, decision_proposal_id,
         base_context_version_id, revision, resulting_context_preview, status
       FROM context_change_proposals
       WHERE project_id = $1 AND id = $2
       FOR UPDATE`,
      [input.projectId, input.contextChangeProposalId],
    );
    const change = changeResult.rows[0];
    if (!change) {
      throw new DomainError("not_found", "Context Change Proposal not found.");
    }

    if (
      proposal.organization_id !== input.organizationId ||
      change.organization_id !== input.organizationId ||
      proposal.project_id !== input.projectId ||
      change.project_id !== input.projectId ||
      change.decision_proposal_id !== proposal.id
    ) {
      throw new DomainError("forbidden", "Proposal provenance does not match project scope.");
    }

    if (
      proposal.status !== "READY_FOR_REVIEW" ||
      change.status !== "READY_FOR_REVIEW"
    ) {
      throw new DomainError("invalid_state", "Proposal is no longer approvable.");
    }

    if (
      proposal.base_context_version_id !== input.expectedContextVersionId ||
      change.base_context_version_id !== input.expectedContextVersionId
    ) {
      throw new DomainError(
        "stale_context_version",
        "Proposal was generated from a different ContextVersion.",
      );
    }

    const latestResult = await transaction.query<{ max_revision: number }>(
      `SELECT MAX(revision)::int AS max_revision
       FROM context_change_proposals
       WHERE project_id = $1 AND decision_proposal_id = $2`,
      [input.projectId, proposal.id],
    );
    if (latestResult.rows[0]?.max_revision !== change.revision) {
      throw new DomainError(
        "stale_context_change_proposal",
        "A newer Context Change Proposal revision exists.",
      );
    }

    const approvalId = this.idFactory("approval");
    const decisionId = this.idFactory("decision");
    const contextVersionId = this.idFactory("context");
    const nextVersionNumber = head.version_number + 1;
    const authoritativeContext = materializeApprovedContext(
      change.resulting_context_preview,
      proposal.id,
      decisionId,
    );
    const contentHash = hashProjectContext(authoritativeContext);

    await transaction.query<Record<string, never>>(
      `UPDATE context_change_proposals
       SET status = 'APPLYING', updated_at = $3
       WHERE project_id = $1 AND id = $2 AND status = 'READY_FOR_REVIEW'`,
      [input.projectId, change.id, input.approvedAt],
    );

    await transaction.query<Record<string, never>>(
      `INSERT INTO approvals (
         id, organization_id, project_id, subject_type, subject_id, decision,
         decided_by_principal_id, expected_context_version_id,
         decision_proposal_id, context_change_proposal_id, created_at
       ) VALUES ($1, $2, $3, 'decision_context_change', $4, 'APPROVED',
                 $5, $6, $7, $8, $9)`,
      [
        approvalId,
        input.organizationId,
        input.projectId,
        change.id,
        input.approvedByPrincipalId,
        input.expectedContextVersionId,
        proposal.id,
        change.id,
        input.approvedAt,
      ],
    );

    await transaction.query<Record<string, never>>(
      `INSERT INTO decisions (
         id, organization_id, project_id, source_decision_proposal_id,
         source_artifact_id, approval_id, title, rationale, alternatives, scope,
         status, approved_by_principal_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
                 'ACTIVE', $11, $12)`,
      [
        decisionId,
        input.organizationId,
        input.projectId,
        proposal.id,
        proposal.source_artifact_id,
        approvalId,
        proposal.title,
        proposal.rationale,
        JSON.stringify(proposal.alternatives),
        JSON.stringify(proposal.scope),
        input.approvedByPrincipalId,
        input.approvedAt,
      ],
    );

    await transaction.query<Record<string, never>>(
      `INSERT INTO context_versions (
         id, organization_id, project_id, version_number,
         parent_context_version_id, content, content_hash,
         created_from_decision_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        contextVersionId,
        input.organizationId,
        input.projectId,
        nextVersionNumber,
        input.expectedContextVersionId,
        JSON.stringify(authoritativeContext),
        contentHash,
        decisionId,
        input.approvedAt,
      ],
    );

    const headUpdate = await transaction.query<Record<string, never>>(
      `UPDATE project_context_heads
       SET current_context_version_id = $2,
           version_number = $3,
           updated_at = $4
       WHERE project_id = $1
         AND current_context_version_id = $5`,
      [
        input.projectId,
        contextVersionId,
        nextVersionNumber,
        input.approvedAt,
        input.expectedContextVersionId,
      ],
    );
    if (headUpdate.rowCount !== 1) {
      throw new DomainError(
        "stale_context_version",
        "Project context head changed during approval.",
      );
    }

    await transaction.query<Record<string, never>>(
      `UPDATE decision_proposals
       SET status = 'APPROVED', updated_at = $3
       WHERE project_id = $1 AND id = $2 AND status = 'READY_FOR_REVIEW'`,
      [input.projectId, proposal.id, input.approvedAt],
    );
    await transaction.query<Record<string, never>>(
      `UPDATE context_change_proposals
       SET status = 'APPLIED', updated_at = $3
       WHERE project_id = $1 AND id = $2 AND status = 'APPLYING'`,
      [input.projectId, change.id, input.approvedAt],
    );

    const correlationId = `decision-promotion:${approvalId}`;
    const causationId = `decision-proposal:${proposal.id}`;
    const events: CommittedDomainEvent[] = [
      {
        id: this.idFactory("event"),
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: "decision.accepted",
        occurredAt: input.approvedAt,
        correlationId,
        causationId,
        actorType: "human",
        actorId: input.approvedByPrincipalId,
        entityType: "Decision",
        entityId: decisionId,
        payload: {
          decisionProposalId: proposal.id,
          contextChangeProposalId: change.id,
          sourceArtifactId: proposal.source_artifact_id,
        },
      },
      {
        id: this.idFactory("event"),
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: "context.version_created",
        occurredAt: input.approvedAt,
        correlationId,
        causationId: `decision:${decisionId}`,
        actorType: "human",
        actorId: input.approvedByPrincipalId,
        entityType: "ContextVersion",
        entityId: contextVersionId,
        payload: {
          previousContextVersionId: input.expectedContextVersionId,
          versionNumber: nextVersionNumber,
          decisionId,
          contentHash,
        },
      },
      {
        id: this.idFactory("event"),
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: "context.updated",
        occurredAt: input.approvedAt,
        correlationId,
        causationId: `context-version:${contextVersionId}`,
        actorType: "human",
        actorId: input.approvedByPrincipalId,
        entityType: "ProjectContext",
        entityId: input.projectId,
        payload: {
          previousContextVersionId: input.expectedContextVersionId,
          currentContextVersionId: contextVersionId,
          versionNumber: nextVersionNumber,
          decisionId,
        },
      },
    ];

    for (const event of events) {
      await insertEvent(transaction, event);
    }

    return {
      result: {
        decisionId,
        contextVersionId,
        versionNumber: nextVersionNumber,
      },
      events,
    };
  }
}

async function insertEvent(
  transaction: SqlExecutor,
  event: CommittedDomainEvent,
): Promise<void> {
  await transaction.query<Record<string, never>>(
    `INSERT INTO events (
       id, organization_id, project_id, type, occurred_at, correlation_id,
       causation_id, actor_type, actor_id, entity_type, entity_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [
      event.id,
      event.organizationId,
      event.projectId,
      event.type,
      event.occurredAt,
      event.correlationId,
      event.causationId,
      event.actorType,
      event.actorId,
      event.entityType,
      event.entityId,
      JSON.stringify(event.payload),
    ],
  );
}
