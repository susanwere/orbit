import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";

interface StepRow extends Record<string, unknown> {
  id: string;
  state: string;
  approval_required: boolean;
  approved_by_principal_id: string | null;
  agent_session_id: string | null;
}

/**
 * Backend authority for starting a single workflow step.
 * This is intentionally separate from provider dispatch and never invokes an agent.
 */
export class WorkflowStepExecutionService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
  ) {}

  /**
   * Terminal completion is only allowed after linked execution succeeded and
   * a persisted, passing evidence record exists. Never infer success from UI.
   */
  async complete(input: { projectId: string; principalId: string; stepId: string }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `orbit:steps:${actor.organizationId}:${input.projectId}`,
      ]);
      const updated = await tx.query<StepRow>(
        `UPDATE workflow_step_executions s
         SET state='COMPLETED',completed_at=now()
         FROM agent_sessions session, plan_proposals p
         WHERE s.id=$1 AND s.project_id=$2 AND s.organization_id=$3
           AND s.state='RUNNING' AND s.agent_session_id IS NOT NULL
           AND session.id=s.agent_session_id AND session.project_id=s.project_id
           AND session.organization_id=s.organization_id AND session.state='COMPLETED'
           AND p.id=s.plan_id AND p.project_id=s.project_id
           AND p.organization_id=s.organization_id AND p.status='APPROVED'
           AND p.revision=s.plan_revision
           AND NOT EXISTS (
             SELECT 1 FROM human_gates gate
             WHERE gate.project_id=s.project_id AND gate.organization_id=s.organization_id
               AND gate.agent_session_id=session.id AND gate.status='OPEN'
           )
           AND EXISTS (
             SELECT 1 FROM evidence e
             WHERE e.agent_session_id=session.id AND e.project_id=s.project_id
               AND e.organization_id=s.organization_id AND e.result='PASSED'
               AND e.scope_type='workflow_step' AND e.scope_id=s.id
           )
         RETURNING s.*`,
        [input.stepId, input.projectId, actor.organizationId],
      );
      if (!updated.rows[0]) {
        throw new DomainError(
          "invalid_state",
          "Step needs a completed linked session, resolved human gates, and passing evidence.",
        );
      }
      return updated.rows[0];
    });
  }

  /**
   * Reset only a proven FAILED step for a new, explicitly human-authorized attempt.
   * Preserve previous Agent Sessions, jobs and evidence; never requeue an old job.
   */
  async authorizeRetry(input: { projectId: string; principalId: string; stepId: string }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `orbit:steps:${actor.organizationId}:${input.projectId}`,
      ]);
      const prior = await tx.query<{ agent_session_id: string | null } & Record<string, unknown>>(
        `SELECT agent_session_id FROM workflow_step_executions
         WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND state='FAILED'
         FOR UPDATE`,
        [input.stepId, input.projectId, actor.organizationId],
      );
      if (!prior.rows[0]) {
        throw new DomainError("invalid_state", "Only a failed step may be retried.");
      }
      const updated = await tx.query<StepRow>(
        `UPDATE workflow_step_executions step
         SET state='BLOCKED',agent_session_id=NULL,approved_by_principal_id=NULL,
             approved_at=NULL,started_at=NULL,completed_at=NULL
         FROM plan_proposals plan
         WHERE step.id=$1 AND step.project_id=$2 AND step.organization_id=$3
           AND step.state='FAILED' AND plan.id=step.plan_id
           AND plan.project_id=step.project_id AND plan.organization_id=step.organization_id
           AND plan.status='APPROVED' AND plan.revision=step.plan_revision
           AND NOT EXISTS (
             SELECT 1 FROM muse_execution_jobs job
             WHERE job.project_id=step.project_id AND job.organization_id=step.organization_id
               AND job.workflow_step_id=step.id
               AND job.status IN ('QUEUED','RUNNING','TURN_FINISHED')
           )
           AND NOT EXISTS (
             SELECT 1 FROM human_gates gate
             WHERE gate.project_id=step.project_id AND gate.organization_id=step.organization_id
               AND gate.agent_session_id=step.agent_session_id AND gate.status='OPEN'
           )
         RETURNING step.*`,
        [input.stepId, input.projectId, actor.organizationId],
      );
      if (!updated.rows[0]) {
        throw new DomainError(
          "invalid_state",
          "Retry requires resolved human gates, no active job, and an approved plan.",
        );
      }
      await tx.query(
        `INSERT INTO events
         (id,organization_id,project_id,type,occurred_at,actor_type,actor_id,
          entity_type,entity_id,payload)
         VALUES(gen_random_uuid()::text,$1,$2,'execution.step.retry_authorized',now(),
                'human',$3,'workflow_step',$4,
                jsonb_build_object('previous_agent_session_id',$5::text))`,
        [
          actor.organizationId,
          input.projectId,
          input.principalId,
          input.stepId,
          prior.rows[0].agent_session_id,
        ],
      );
      return updated.rows[0];
    });
  }

  async approve(input: { projectId: string; principalId: string; stepId: string }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `orbit:steps:${actor.organizationId}:${input.projectId}`,
      ]);
      const updated = await tx.query<StepRow>(
        `UPDATE workflow_step_executions s
         SET approved_by_principal_id=$4, approved_at=now()
         FROM plan_proposals p
         WHERE s.id=$1 AND s.project_id=$2 AND s.organization_id=$3
           AND p.id=s.plan_id AND p.project_id=s.project_id
           AND p.organization_id=s.organization_id
           AND p.status='APPROVED' AND p.revision=s.plan_revision
           AND s.approval_required=true AND s.approved_by_principal_id IS NULL
           AND s.state IN ('BLOCKED','READY')
         RETURNING s.*`,
        [input.stepId, input.projectId, actor.organizationId, input.principalId],
      );
      if (!updated.rows[0]) {
        throw new DomainError(
          "invalid_state",
          "Step cannot be approved or has already been reviewed.",
        );
      }
      return updated.rows[0];
    });
  }

  async start(input: { projectId: string; principalId: string; stepId: string }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    return this.db.transaction(async (tx) => {
      // Serialize competing starts and prerequisite completions for this project.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `orbit:steps:${actor.organizationId}:${input.projectId}`,
      ]);
      const step = await tx.query<StepRow>(
        `SELECT s.id,s.state,s.approval_required,s.approved_by_principal_id,s.agent_session_id
         FROM workflow_step_executions s
         JOIN plan_proposals p ON p.id=s.plan_id
           AND p.project_id=s.project_id AND p.organization_id=s.organization_id
         WHERE s.id=$1 AND s.project_id=$2 AND s.organization_id=$3
           AND p.status='APPROVED' AND p.revision=s.plan_revision
         FOR UPDATE OF s`,
        [input.stepId, input.projectId, actor.organizationId],
      );
      const current = step.rows[0];
      if (!current) throw new DomainError("invalid_state", "No approved matching plan step.");
      if (current.state !== "READY" && current.state !== "BLOCKED") {
        throw new DomainError("invalid_state", "Step cannot be started in its current state.");
      }
      if (current.approval_required && !current.approved_by_principal_id) {
        throw new DomainError("invalid_state", "Step is awaiting human approval.");
      }
      const dependencies = await tx.query<{ id: string } & Record<string, unknown>>(
        `SELECT prerequisite.id FROM workflow_step_prerequisites edge
         JOIN workflow_step_executions prerequisite
           ON prerequisite.project_id=edge.project_id
           AND prerequisite.id=edge.prerequisite_step_id
         WHERE edge.step_id=$1 AND edge.project_id=$2 AND edge.organization_id=$3
           AND prerequisite.organization_id=$3
           AND (prerequisite.state <> 'COMPLETED'
             OR prerequisite.plan_id <> (
               SELECT plan_id FROM workflow_step_executions
               WHERE id=$1 AND project_id=$2 AND organization_id=$3
             ))`,
        [input.stepId, input.projectId, actor.organizationId],
      );
      if (dependencies.rows.length) {
        throw new DomainError("invalid_state", "Step prerequisites are not completed.");
      }
      // A bound agent must still be authorized at the moment this step starts.
      // Revocation or cancellation after binding must invalidate execution.
      const linkedSession = await tx.query<{ id: string } & Record<string, unknown>>(
        `SELECT s.id FROM workflow_step_executions step
         JOIN agent_sessions s ON s.id=step.agent_session_id
           AND s.project_id=step.project_id AND s.organization_id=step.organization_id
         WHERE step.id=$1 AND step.project_id=$2 AND step.organization_id=$3
           AND s.state='AUTHORIZED'
         LIMIT 1`,
        [input.stepId, input.projectId, actor.organizationId],
      );
      if (current.agent_session_id && !linkedSession.rows.length) {
        throw new DomainError("invalid_state", "Bound agent session is not authorized.");
      }
      // A previously approved step must not bypass a newly opened human gate.
      // Recheck inside the same project-serialized transaction as step start.
      const gates = await tx.query<{ id: string } & Record<string, unknown>>(
        `SELECT gate.id FROM human_gates gate
         JOIN workflow_step_executions s ON s.agent_session_id=gate.agent_session_id
           AND s.project_id=gate.project_id AND s.organization_id=gate.organization_id
         WHERE s.id=$1 AND s.project_id=$2 AND s.organization_id=$3
           AND gate.status='OPEN'
         LIMIT 1`,
        [input.stepId, input.projectId, actor.organizationId],
      );
      if (gates.rows.length) {
        throw new DomainError("invalid_state", "Step has an unresolved human gate.");
      }
      // This transition authorizes the step only; a separate explicit dispatch
      // must bind an Agent Session and check its Execution Contract.
      const updated = await tx.query<StepRow>(
        `UPDATE workflow_step_executions
         SET state='RUNNING',started_at=now()
         WHERE id=$1 AND project_id=$2 AND organization_id=$3
           AND state IN ('READY','BLOCKED') RETURNING *`,
        [input.stepId, input.projectId, actor.organizationId],
      );
      if (!updated.rows[0]) throw new DomainError("invalid_state", "Step start conflict.");
      return updated.rows[0];
    });
  }
}
