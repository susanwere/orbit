import type { ContextChangeProposal } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";

interface ContextChangeProposalRow extends Record<string, unknown> {
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

const asIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

function mapRow(row: ContextChangeProposalRow): ContextChangeProposal {
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
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

export class ContextChangeProposalRepository {
  constructor(private readonly database: SqlDatabase) {}

  async create(proposal: ContextChangeProposal): Promise<ContextChangeProposal> {
    const result = await this.database.query<ContextChangeProposalRow>(
      `INSERT INTO context_change_proposals (
         id,
         organization_id,
         project_id,
         decision_proposal_id,
         base_context_version_id,
         revision,
         operations,
         resulting_context_preview,
         status,
         failure_reason,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12
       )
       RETURNING
         id,
         organization_id,
         project_id,
         decision_proposal_id,
         base_context_version_id,
         revision,
         operations,
         resulting_context_preview,
         status,
         failure_reason,
         created_at,
         updated_at`,
      [
        proposal.id,
        proposal.organizationId,
        proposal.projectId,
        proposal.decisionProposalId,
        proposal.baseContextVersionId,
        proposal.revision,
        JSON.stringify(proposal.operations),
        JSON.stringify(proposal.resultingContextPreview),
        proposal.status,
        proposal.failureReason ?? null,
        proposal.createdAt,
        proposal.updatedAt,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Context Change Proposal insert returned no row.");
    }

    return mapRow(row);
  }

  async getById(projectId: string, proposalId: string): Promise<ContextChangeProposal | null> {
    const result = await this.database.query<ContextChangeProposalRow>(
      `SELECT
         id,
         organization_id,
         project_id,
         decision_proposal_id,
         base_context_version_id,
         revision,
         operations,
         resulting_context_preview,
         status,
         failure_reason,
         created_at,
         updated_at
       FROM context_change_proposals
       WHERE project_id = $1
         AND id = $2`,
      [projectId, proposalId],
    );

    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}
