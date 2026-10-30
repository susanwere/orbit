import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";

/** Binds one authorized agent session to a step in an immutable approved plan. */
export class StepSessionBindingService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
  ) {}

  async bind(input: { projectId: string; principalId: string; stepId: string; sessionId: string }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `orbit:steps:${actor.organizationId}:${input.projectId}`,
      ]);
      const result = await tx.query<Record<string, unknown>>(
        `UPDATE workflow_step_executions step
         SET agent_session_id=$4
         FROM agent_sessions session, plan_proposals plan
         WHERE step.id=$1 AND step.project_id=$2 AND step.organization_id=$3
           AND step.state IN ('BLOCKED','READY') AND step.agent_session_id IS NULL
           AND plan.id=step.plan_id AND plan.project_id=step.project_id
           AND plan.organization_id=step.organization_id
           AND plan.status='APPROVED' AND plan.revision=step.plan_revision
           AND session.id=$4 AND session.project_id=step.project_id
           AND session.organization_id=step.organization_id AND session.state='AUTHORIZED'
           AND session.work_item_id=step.work_item_key
           AND (session.requested_by_principal_id=$5
                OR session.human_owner_principal_id=$5 OR $6='admin')
         RETURNING step.*`,
        [
          input.stepId,
          input.projectId,
          actor.organizationId,
          input.sessionId,
          input.principalId,
          actor.role,
        ],
      );
      if (!result.rows[0])
        throw new DomainError("invalid_state", "Session is not eligible for this approved step.");
      return result.rows[0];
    });
  }
}
