import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import { validateProposedWorkGraph } from "../planning/muse-work-graph-planner.js";

/**
 * Materializes the *approved* immutable plan to scoped step records.
 * Workflows in one work item are parallel unless their work item depends on another.
 * Step order within a workflow is sequential.
 * No agent or external provider is invoked here.
 */
export class ApprovedStepMaterializer {
  constructor(
    private readonly db: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
  ) {}

  async materialize(projectId: string, principalId: string) {
    const actor = await this.authorization.authorize(principalId, projectId, "review");
    return this.db.transaction(async (tx) => {
      const approved = await tx.query<
        {
          id: string;
          revision: number;
          content: unknown;
        } & Record<string, unknown>
      >(
        `SELECT id,revision,content FROM plan_proposals
         WHERE project_id=$1 AND organization_id=$2 AND status='APPROVED'
         FOR UPDATE`,
        [projectId, actor.organizationId],
      );
      const plan = approved.rows[0];
      if (!plan) throw new DomainError("invalid_state", "Approve the plan before preparing steps.");
      const graph = validateProposedWorkGraph(plan.content);
      const existing = await tx.query<{ id: string } & Record<string, unknown>>(
        `SELECT id FROM workflow_step_executions
         WHERE project_id=$1 AND organization_id=$2 AND plan_id=$3 LIMIT 1`,
        [projectId, actor.organizationId, plan.id],
      );
      if (existing.rows.length) {
        throw new DomainError(
          "invalid_state",
          "This plan has already been prepared for execution.",
        );
      }

      const stepId = (key: string, workflow: number, step: number) =>
        `step:${plan.id}:${key}:${workflow}:${step}`;
      let count = 0;
      for (const item of graph.workItems) {
        for (const [workflowIndex, workflow] of item.workflows.entries()) {
          for (const [stepIndex, step] of workflow.steps.entries()) {
            await tx.query(
              `INSERT INTO workflow_step_executions
               (id,organization_id,project_id,plan_id,plan_revision,work_item_key,
                workflow_index,step_index,state,approval_required)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,'BLOCKED',$9)`,
              [
                stepId(item.key, workflowIndex, stepIndex),
                actor.organizationId,
                projectId,
                plan.id,
                plan.revision,
                item.key,
                workflowIndex,
                stepIndex,
                step.requiresApproval,
              ],
            );
            count++;
          }
        }
      }
      for (const item of graph.workItems) {
        for (const [workflowIndex, workflow] of item.workflows.entries()) {
          for (const stepIndex of workflow.steps.keys()) {
            const prerequisites: string[] = [];
            if (stepIndex > 0) {
              prerequisites.push(stepId(item.key, workflowIndex, stepIndex - 1));
            } else {
              // Dependencies between work items require every workflow
              // in a predecessor item to finish. Sibling workflows are parallel.
              for (const dependency of item.dependsOn) {
                const predecessor = graph.workItems.find(
                  (candidate) => candidate.key === dependency,
                )!;
                predecessor.workflows.forEach((previousWorkflow, previousIndex) => {
                  prerequisites.push(
                    stepId(dependency, previousIndex, previousWorkflow.steps.length - 1),
                  );
                });
              }
            }
            for (const prerequisite of prerequisites) {
              await tx.query(
                `INSERT INTO workflow_step_prerequisites
                  (organization_id,project_id,step_id,prerequisite_step_id)
                 VALUES($1,$2,$3,$4)`,
                [
                  actor.organizationId,
                  projectId,
                  stepId(item.key, workflowIndex, stepIndex),
                  prerequisite,
                ],
              );
            }
          }
        }
      }
      return { planId: plan.id, revision: plan.revision, stepCount: count };
    });
  }
}
