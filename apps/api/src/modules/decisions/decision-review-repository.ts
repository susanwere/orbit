import {
  DomainError,
  type ContextChangeProposal,
  type DecisionProposal,
} from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";

interface DecisionProposalRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  source_artifact_id: string;
  source_quote: string | null;
  title: string;
  rationale: string;
  alternatives: string[];
  scope: string[];
  confidence: number | null;
  base_context_version_id: string;
  status: DecisionProposal["status"];
  detected_by_principal_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ChangeRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  decision_proposal_id: string;
  base_context_version_id: string;
  revision: number;
  operations: ContextChangeProposal["operations"];
  resulting_context_preview: ContextChangeProposal["resultingContextPreview"];
  status: ContextChangeProposal["status"];
  failure_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : value;

function mapDecision(row: DecisionProposalRow): DecisionProposal {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    sourceArtifactId: row.source_artifact_id,
    sourceQuote: row.source_quote ?? undefined,
    title: row.title,
    rationale: row.rationale,
    alternatives: row.alternatives,
    scope: row.scope,
    confidence: row.confidence ?? undefined,
    baseContextVersionId: row.base_context_version_id,
    status: row.status,
    detectedByPrincipalId: row.detected_by_principal_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapChange(row: ChangeRow): ContextChangeProposal {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    decisionProposalId: row.decision_proposal_id,
    baseContextVersionId: row.base_context_version_id,
    revision: row.revision,
    operations: row.operations,
    resultingContextPreview: row.resulting_context_preview,
    status: row.status,
    failureReason: row.failure_reason ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface DecisionReviewBundle {
  readonly decisionProposal: DecisionProposal;
  readonly contextChangeProposal: ContextChangeProposal;
}

export class DecisionReviewRepository {
  constructor(private readonly database: SqlDatabase) {}

  async getBundle(
    projectId: string,
    decisionProposalId: string,
  ): Promise<DecisionReviewBundle | null> {
    const decisionResult = await this.database.query<DecisionProposalRow>(
      `SELECT *
       FROM decision_proposals
       WHERE project_id = $1 AND id = $2`,
      [projectId, decisionProposalId],
    );
    const decisionRow = decisionResult.rows[0];
    if (!decisionRow) return null;

    const changeResult = await this.database.query<ChangeRow>(
      `SELECT *
       FROM context_change_proposals
       WHERE project_id = $1
         AND decision_proposal_id = $2
       ORDER BY revision DESC
       LIMIT 1`,
      [projectId, decisionProposalId],
    );
    const changeRow = changeResult.rows[0];
    if (!changeRow) {
      throw new DomainError(
        "invalid_state",
        "Decision proposal has no Context Change Proposal.",
      );
    }

    return {
      decisionProposal: mapDecision(decisionRow),
      contextChangeProposal: mapChange(changeRow),
    };
  }

  async updateDecisionReviewFields(
    projectId: string,
    decisionProposalId: string,
    input: { readonly title?: string; readonly rationale?: string; readonly updatedAt: string },
  ): Promise<DecisionProposal> {
    const result = await this.database.query<DecisionProposalRow>(
      `UPDATE decision_proposals
       SET title = COALESCE($3, title),
           rationale = COALESCE($4, rationale),
           updated_at = $5
       WHERE project_id = $1
         AND id = $2
         AND status = 'READY_FOR_REVIEW'
       RETURNING *`,
      [
        projectId,
        decisionProposalId,
        input.title ?? null,
        input.rationale ?? null,
        input.updatedAt,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new DomainError(
        "invalid_state",
        "Decision proposal is not available for editing.",
      );
    }
    return mapDecision(row);
  }

  /**
   * Serialize competing rebase/review writes under the project lock. The
   * second review is mandatory even when the append is conflict-free.
   */
  async rebase(
    decision: DecisionProposal,
    previous: ContextChangeProposal,
    next: ContextChangeProposal,
  ): Promise<DecisionReviewBundle> {
    return this.database.transaction(async (transaction) => {
      await transaction.query<Record<string, unknown>>(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [decision.projectId],
      );
      const head = await transaction.query<{ current_context_version_id: string }>(
        `SELECT current_context_version_id FROM project_context_heads
         WHERE project_id = $1 FOR UPDATE`,
        [decision.projectId],
      );
      if (head.rows[0]?.current_context_version_id !== next.baseContextVersionId) {
        throw new DomainError("stale_context_version", "Context advanced while rebasing.");
      }
      const decisionRow = await transaction.query<DecisionProposalRow>(
        `SELECT * FROM decision_proposals WHERE project_id = $1 AND id = $2 FOR UPDATE`,
        [decision.projectId, decision.id],
      );
      if (decisionRow.rows[0]?.status !== "READY_FOR_REVIEW") {
        throw new DomainError("invalid_state", "Decision proposal is no longer reviewable.");
      }
      const latest = await transaction.query<ChangeRow>(
        `SELECT * FROM context_change_proposals
         WHERE project_id = $1 AND decision_proposal_id = $2
         ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        [decision.projectId, decision.id],
      );
      if (
        latest.rows[0]?.id !== previous.id ||
        latest.rows[0]?.revision !== previous.revision ||
        latest.rows[0]?.status !== "READY_FOR_REVIEW"
      ) {
        throw new DomainError("stale_context_change_proposal", "Proposal revision changed.");
      }
      const inserted = await transaction.query<ChangeRow>(
        `INSERT INTO context_change_proposals (
          id, organization_id, project_id, decision_proposal_id,
          base_context_version_id, revision, operations,
          resulting_context_preview, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
        RETURNING *`,
        [
          next.id, next.organizationId, next.projectId, next.decisionProposalId,
          next.baseContextVersionId, next.revision,
          JSON.stringify(next.operations), JSON.stringify(next.resultingContextPreview),
          next.status, next.createdAt, next.updatedAt,
        ],
      );
      const updatedDecision = await transaction.query<DecisionProposalRow>(
        `UPDATE decision_proposals
         SET base_context_version_id = $3, updated_at = $4
         WHERE project_id = $1 AND id = $2 AND status = 'READY_FOR_REVIEW'
         RETURNING *`,
        [decision.projectId, decision.id, next.baseContextVersionId, next.createdAt],
      );
      if (!inserted.rows[0] || !updatedDecision.rows[0]) {
        throw new DomainError("invalid_state", "Could not persist rebased proposal.");
      }
      return {
        decisionProposal: mapDecision(updatedDecision.rows[0]),
        contextChangeProposal: mapChange(inserted.rows[0]),
      };
    });
  }

  async reject(
    projectId: string,
    decisionProposalId: string,
    contextChangeProposalId: string,
    updatedAt: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const decision = await transaction.query<Record<string, unknown>>(
        `UPDATE decision_proposals
         SET status = 'REJECTED', updated_at = $3
         WHERE project_id = $1
           AND id = $2
           AND status = 'READY_FOR_REVIEW'`,
        [projectId, decisionProposalId, updatedAt],
      );
      if (decision.rowCount !== 1) {
        throw new DomainError("invalid_state", "Decision proposal cannot be rejected.");
      }

      const change = await transaction.query<Record<string, unknown>>(
        `UPDATE context_change_proposals
         SET status = 'REJECTED', updated_at = $3
         WHERE project_id = $1
           AND id = $2
           AND status = 'READY_FOR_REVIEW'`,
        [projectId, contextChangeProposalId, updatedAt],
      );
      if (change.rowCount !== 1) {
        throw new DomainError(
          "invalid_state",
          "Context Change Proposal cannot be rejected.",
        );
      }
    });
  }
}
