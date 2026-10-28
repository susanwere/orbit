import { randomUUID } from "node:crypto";
import { DomainError, type ContextSnapshot, type ProjectContext } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import { evaluateExecutionImpact } from "./evaluate-execution-impact.js";

interface VersionRow extends Record<string, unknown> {
  id: string;
  content: ProjectContext;
}
interface SessionRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  mission: string;
  human_owner_principal_id: string;
  context_snapshot_id: string;
  snapshot_items: ContextSnapshot["items"];
  snapshot_included_paths: string[];
  snapshot_included_constraint_ids: string[];
  snapshot_included_decision_ids: string[];
  snapshot_excluded_paths: string[];
  snapshot_source_context_version_id: string;
  snapshot_authorization_basis: ContextSnapshot["authorizationBasis"];
  snapshot_max_classification: ContextSnapshot["maxClassification"];
  snapshot_allowed_repositories: string[];
  snapshot_allowed_paths: string[];
  snapshot_forbidden_data: string[];
  snapshot_approval_required_actions: string[];
  contract_allowed_paths: string[];
}
export interface ImpactSummary {
  reviewed: number;
  continued: number;
}
/**
 * Idempotently pauses only materially affected RUNNING sessions.
 * The existing context snapshot is never mutated, replaced or rebased.
 */
export class PostgresExecutionImpactService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly newId: () => string = randomUUID,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async evaluate(input: {
    organizationId: string;
    projectId: string;
    previousContextVersionId: string;
    currentContextVersionId: string;
  }): Promise<ImpactSummary> {
    return this.db.transaction(async (tx) => {
      await tx.query<Record<string, never>>(
        "SELECT pg_advisory_xact_lock(hashtext($1))", [input.projectId],
      );
      const head = await tx.query<{ current_context_version_id: string }>(
        "SELECT current_context_version_id FROM project_context_heads WHERE project_id = $1 FOR SHARE",
        [input.projectId],
      );
      if (head.rows[0]?.current_context_version_id !== input.currentContextVersionId) {
        throw new DomainError("stale_context_version", "Context head changed before impact evaluation.");
      }
      const versions = await tx.query<VersionRow>(
        `SELECT id, content FROM context_versions
         WHERE organization_id = $1 AND project_id = $2 AND id IN ($3, $4)`,
        [
          input.organizationId, input.projectId, input.previousContextVersionId,
          input.currentContextVersionId,
        ],
      );
      const byId = new Map(versions.rows.map((v) => [v.id, v.content]));
      const previous = byId.get(input.previousContextVersionId);
      const current = byId.get(input.currentContextVersionId);
      if (!previous || !current) {
        throw new DomainError("not_found", "Impact context versions not found.");
      }

      const running = await tx.query<SessionRow>(
        `SELECT s.id, s.organization_id, s.project_id, s.mission,
           s.human_owner_principal_id, s.context_snapshot_id,
           cs.items AS snapshot_items,
           cs.included_paths AS snapshot_included_paths,
           cs.included_constraint_ids AS snapshot_included_constraint_ids,
           cs.included_decision_ids AS snapshot_included_decision_ids,
           cs.excluded_paths AS snapshot_excluded_paths,
           cs.source_context_version_id AS snapshot_source_context_version_id,
           cs.authorization_basis AS snapshot_authorization_basis,
           cs.max_classification AS snapshot_max_classification,
           cs.allowed_repositories AS snapshot_allowed_repositories,
           cs.allowed_paths AS snapshot_allowed_paths,
           cs.forbidden_data AS snapshot_forbidden_data,
           cs.approval_required_actions AS snapshot_approval_required_actions,
           ec.allowed_paths AS contract_allowed_paths
         FROM agent_sessions s
         JOIN context_snapshots cs
           ON cs.project_id = s.project_id AND cs.id = s.context_snapshot_id
         JOIN execution_contracts ec
           ON ec.project_id = s.project_id AND ec.id = s.execution_contract_id
         WHERE s.organization_id = $1 AND s.project_id = $2 AND s.state = 'RUNNING'
         FOR UPDATE OF s`,
        [input.organizationId, input.projectId],
      );
      let reviewed = 0;
      let continued = 0;
      for (const session of running.rows) {
        const snapshot: ContextSnapshot = {
          id: session.context_snapshot_id,
          organizationId: session.organization_id,
          projectId: session.project_id,
          sourceContextVersionId: session.snapshot_source_context_version_id,
          mission: session.mission,
          items: session.snapshot_items,
          includedDecisionIds: session.snapshot_included_decision_ids,
          includedConstraintIds: session.snapshot_included_constraint_ids,
          includedPaths: session.snapshot_included_paths,
          excludedPaths: session.snapshot_excluded_paths,
          authorizationBasis: session.snapshot_authorization_basis,
          maxClassification: session.snapshot_max_classification,
          allowedRepositories: session.snapshot_allowed_repositories,
          allowedPaths: session.snapshot_allowed_paths,
          forbiddenData: session.snapshot_forbidden_data,
          approvalRequiredActions: session.snapshot_approval_required_actions,
          createdAt: this.clock(),
        };
        const decision = evaluateExecutionImpact({
          previous, current, snapshot, mission: session.mission,
          allowedPaths: session.contract_allowed_paths,
        });
        if (decision.result === "ALLOW_CONTINUE") {
          continued++;
          continue;
        }
        const updated = await tx.query<Record<string, never>>(
          `UPDATE agent_sessions SET state = 'WAITING'
           WHERE project_id = $1 AND id = $2 AND state = 'RUNNING'`,
          [input.projectId, session.id],
        );
        if (updated.rowCount !== 1) continue;
        reviewed++;
        const eventId = `event_${this.newId()}`;
        const now = this.clock();
        await tx.query<Record<string, never>>(
          `INSERT INTO events (
            id, organization_id, project_id, type, occurred_at, correlation_id,
            causation_id, actor_type, actor_id, entity_type, entity_id, payload
          ) VALUES ($1,$2,$3,'execution.review_required',$4,$5,$6,'system','orbit','AgentSession',$7,$8::jsonb)`,
          [
            eventId, input.organizationId, input.projectId, now,
            `context-impact:${input.currentContextVersionId}`,
            `context-version:${input.currentContextVersionId}`,
            session.id,
            JSON.stringify({
              agentSessionId: session.id,
              currentContextVersionId: input.currentContextVersionId,
              previousContextVersionId: input.previousContextVersionId,
              affectedPaths: decision.affectedPaths,
            }),
          ],
        );
        await tx.query<Record<string, never>>(
          `INSERT INTO notifications (
             id, organization_id, project_id, recipient_principal_id, type,
             subject_type, subject_id, title, body, created_at
           ) VALUES ($1,$2,$3,$4,'EXECUTION_REVIEW_REQUIRED',
             'agent_session',$5,'Context changed during execution',
             'Review material changes before resuming work.',$6)`,
          [`notification_${this.newId()}`, input.organizationId, input.projectId,
            session.human_owner_principal_id, session.id, now],
        );
      }
      return { reviewed, continued };
    });
  }
}
