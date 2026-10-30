import type { FastifyInstance } from "fastify";
import type { AuthVerifier } from "../auth/verified-principal.js";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import type { ApprovedStepMaterializer } from "./approved-step-materializer.js";

export interface WorkflowStepRouteOptions {
  readonly auth: AuthVerifier;
  readonly db: SqlDatabase;
  readonly authorization: ProjectAuthorizationService;
  readonly materializer: ApprovedStepMaterializer;
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
        `SELECT id,plan_id,plan_revision,work_item_key,workflow_index,step_index,
           state,approval_required,approved_at,agent_session_id,started_at,completed_at
         FROM workflow_step_executions
         WHERE project_id=$1 AND organization_id=$2
         ORDER BY work_item_key,workflow_index,step_index LIMIT 1000`,
        [actor.projectId, actor.organizationId],
      );
      return { steps: result.rows };
    },
  );
}
