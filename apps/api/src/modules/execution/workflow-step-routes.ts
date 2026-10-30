import { DomainError } from "@orbit/domain";
import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import type { StepSessionBindingService } from "./step-session-binding-service.js";
import type { WorkflowStepExecutionService } from "./workflow-step-execution-service.js";
import type { ApprovedStepMaterializer } from "./approved-step-materializer.js";

export interface WorkflowStepRouteOptions {
  readonly auth: AuthVerifier;
  readonly db: SqlDatabase;
  readonly authorization: ProjectAuthorizationService;
  readonly materializer: ApprovedStepMaterializer;
  readonly execution: WorkflowStepExecutionService;
  readonly binding: StepSessionBindingService;
}

/** Exposes human-controlled plan preparation and authoritative step reads.
 * No endpoint in this module starts an agent or declares a step completed.
 */
export async function registerWorkflowStepRoutes(
  app: FastifyInstance,
  options: WorkflowStepRouteOptions,
) {
  app.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/execution/prepare",
    async (request, reply) => {
      const principal = options.auth.verify(request.headers.authorization);
      const prepared = await options.materializer.materialize(
        request.params.projectId,
        principal.id,
      );
      return reply.status(201).send(prepared);
    },
  );
  app.post<{ Params: { projectId: string; stepId: string }; Body: { sessionId?: string } }>(
    "/projects/:projectId/execution/steps/:stepId/bind-session",
    async (request) => {
      const principal = options.auth.verify(request.headers.authorization);
      const sessionId = request.body?.sessionId;
      if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200) {
        throw new DomainError("validation", "A valid sessionId is required.");
      }
      return {
        step: await options.binding.bind({
          projectId: request.params.projectId,
          stepId: request.params.stepId,
          sessionId,
          principalId: principal.id,
        }),
      };
    },
  );
  app.post<{ Params: { projectId: string; stepId: string } }>(
    "/projects/:projectId/execution/steps/:stepId/approve",
    async (request) => {
      const principal = options.auth.verify(request.headers.authorization);
      return {
        step: await options.execution.approve({
          projectId: request.params.projectId,
          stepId: request.params.stepId,
          principalId: principal.id,
        }),
      };
    },
  );
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/execution/steps",
    async (request) => {
      const principal = options.auth.verify(request.headers.authorization);
      const actor = await options.authorization.authorize(
        principal.id,
        request.params.projectId,
        "read",
      );
      const result = await options.db.query<Record<string, unknown>>(
        `SELECT s.id,s.plan_id,s.plan_revision,s.work_item_key,s.workflow_index,
           s.step_index,s.state,s.approval_required,s.approved_at,
           s.agent_session_id,s.started_at,s.completed_at,
           CASE
             WHEN s.state='COMPLETED' THEN 'completed'
             WHEN s.state='FAILED' THEN 'failed'
             WHEN s.state='CANCELED' THEN 'canceled'
             WHEN s.state='RUNNING' THEN 'running'
             WHEN s.state='WAITING' THEN 'waiting'
             WHEN p.status IS DISTINCT FROM 'APPROVED'
                  OR p.revision IS DISTINCT FROM s.plan_revision THEN 'plan_not_approved'
             WHEN s.approval_required AND s.approved_by_principal_id IS NULL
               THEN 'human_approval_required'
             WHEN EXISTS (
               SELECT 1 FROM workflow_step_prerequisites edge
               JOIN workflow_step_executions prerequisite
                 ON prerequisite.id=edge.prerequisite_step_id
                AND prerequisite.project_id=edge.project_id
               WHERE edge.project_id=s.project_id AND edge.step_id=s.id
                 AND (prerequisite.state <> 'COMPLETED'
                      OR prerequisite.plan_id <> s.plan_id)
             ) THEN 'prerequisite_incomplete'
             WHEN s.agent_session_id IS NULL THEN 'agent_session_required'
             WHEN EXISTS (
               SELECT 1 FROM human_gates gate
               WHERE gate.project_id=s.project_id
                 AND gate.organization_id=s.organization_id
                 AND gate.agent_session_id=s.agent_session_id AND gate.status='OPEN'
             ) THEN 'human_gate_open'
             WHEN session.state IS DISTINCT FROM 'AUTHORIZED' THEN 'session_not_authorized'
             ELSE NULL
           END AS blocker_reason
         FROM workflow_step_executions s
         JOIN plan_proposals p ON p.id=s.plan_id AND p.project_id=s.project_id
           AND p.organization_id=s.organization_id
         LEFT JOIN agent_sessions session ON session.id=s.agent_session_id
           AND session.project_id=s.project_id AND session.organization_id=s.organization_id
         WHERE s.project_id=$1 AND s.organization_id=$2
         ORDER BY s.work_item_key,s.workflow_index,s.step_index LIMIT 1000`,
        [actor.projectId, actor.organizationId],
      );
      return { steps: result.rows };
    },
  );
}
