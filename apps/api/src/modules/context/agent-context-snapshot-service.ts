import { randomUUID } from "node:crypto";
import { DomainError, type AgentDefinition, type ContextSnapshot, type Decision } from "@orbit/domain";
import type { SqlDatabase, SqlExecutor } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import { resolveContextSnapshot } from "./resolve-agent-context.js";

interface CurrentVersionRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  version_number: number;
  content: import("@orbit/domain").ProjectContext;
  content_hash: string;
  created_at: Date | string;
}
interface DecisionRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  source_decision_proposal_id: string;
  source_artifact_id: string;
  title: string;
  rationale: string;
  alternatives: string[];
  scope: string[];
  status: "ACTIVE" | "SUPERSEDED";
  approved_by_principal_id: string;
  created_at: Date | string;
}
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : value;

export class AgentContextSnapshotService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly auth: ProjectAuthorizationService,
    private readonly id: () => string = randomUUID,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async create(input: {
    projectId: string;
    requestedByPrincipalId: string;
    agent: AgentDefinition;
    mission: string;
  }): Promise<ContextSnapshot> {
    const actor = await this.auth.authorize(input.requestedByPrincipalId, input.projectId, "read");
    if (actor.organizationId !== input.agent.organizationId) {
      throw new DomainError("forbidden", "Agent is not authorized for this organization.");
    }
    return this.database.transaction(async (tx) => this.createWithinTransaction(tx, input));
  }

  async createWithinTransaction(tx: SqlExecutor, input: {
    projectId: string;
    requestedByPrincipalId: string;
    agent: AgentDefinition;
    mission: string;
  }): Promise<ContextSnapshot> {
    // Lock current head before resolving; an approved context change cannot
    // sneak in between reading the head and persisting the snapshot.
    const result = await tx.query<CurrentVersionRow>(
      `SELECT cv.id, cv.organization_id, cv.project_id, cv.version_number,
              cv.content, cv.content_hash, cv.created_at
       FROM project_context_heads h
       JOIN context_versions cv ON cv.id = h.current_context_version_id
         AND cv.project_id = h.project_id
       WHERE h.project_id = $1 FOR SHARE OF h`,
      [input.projectId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("not_found", "Current project context not found.");
    const decisions = await tx.query<DecisionRow>(
      `SELECT * FROM decisions
       WHERE project_id = $1 AND organization_id = $2 AND status = 'ACTIVE'`,
      [input.projectId, row.organization_id],
    );
    const active: Decision[] = decisions.rows.map((d) => ({
      id: d.id, organizationId: d.organization_id, projectId: d.project_id,
      sourceDecisionProposalId: d.source_decision_proposal_id,
      sourceArtifactId: d.source_artifact_id,
      title: d.title, rationale: d.rationale,
      alternatives: d.alternatives, scope: d.scope,
      status: d.status, approvedByPrincipalId: d.approved_by_principal_id,
      createdAt: iso(d.created_at),
    }));
    const snapshot = resolveContextSnapshot({
      id: `snapshot_${this.id()}`,
      version: {
        id: row.id, organizationId: row.organization_id, projectId: row.project_id,
        versionNumber: row.version_number, content: row.content,
        contentHash: row.content_hash, createdAt: iso(row.created_at),
      },
      activeDecisions: active,
      agent: input.agent,
      mission: input.mission,
      requestedByPrincipalId: input.requestedByPrincipalId,
      createdAt: this.clock(),
    });
    await tx.query<Record<string, never>>(
      `INSERT INTO context_snapshots (
        id, organization_id, project_id, source_context_version_id, mission,
        items, included_decision_ids, included_constraint_ids,
        included_paths, excluded_paths, authorization_basis,
        max_classification, allowed_repositories, allowed_paths,
        forbidden_data, approval_required_actions, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
        $9::jsonb, $10::jsonb, $11::jsonb, $12,
        $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17)`,
      [
        snapshot.id, snapshot.organizationId, snapshot.projectId,
        snapshot.sourceContextVersionId, snapshot.mission,
        JSON.stringify(snapshot.items), JSON.stringify(snapshot.includedDecisionIds),
        JSON.stringify(snapshot.includedConstraintIds), JSON.stringify(snapshot.includedPaths),
        JSON.stringify(snapshot.excludedPaths), JSON.stringify(snapshot.authorizationBasis),
        snapshot.maxClassification, JSON.stringify(snapshot.allowedRepositories),
        JSON.stringify(snapshot.allowedPaths), JSON.stringify(snapshot.forbiddenData),
        JSON.stringify(snapshot.approvalRequiredActions), snapshot.createdAt,
      ],
    );
    return snapshot;
  }
}
