import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import { ApprovedStepMaterializer } from "../execution/approved-step-materializer.js";
import { StepSessionBindingService } from "../execution/step-session-binding-service.js";
import { WorkflowStepExecutionService } from "../execution/workflow-step-execution-service.js";
import { AgentSessionService } from "../agents/agent-session-service.js";
import { MuseExecutionJobService } from "../execution/muse-execution-worker.js";
import { MuseDeliveryRequestService } from "../execution/muse-delivery-request-service.js";
import { validateProposedWorkGraph } from "../planning/muse-work-graph-planner.js";
import { synchronizeWorkflowReviewContext } from "../context/workflow-review-context.js";

interface TaskExecutionRow extends Record<string, unknown> {
  id: string;
  plan_id: string;
  task_key: string;
  title: string;
  prompt: string;
  revision: number;
  state: string;
  step_id: string | null;
  session_id: string | null;
  dependency_keys: string[];
}

/**
 * The single human authorization in the prompt-first flow: clicking Execute.
 * It approves the plan if needed, materializes its steps, binds the task to
 * its first agent step, and queues one Muse run whose mission is the
 * editable task prompt. Delivery and CI repair are then driven by workers;
 * the only remaining human action is merging the pull request.
 */
export class TaskExecutionService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
    private readonly materializer: ApprovedStepMaterializer,
    private readonly sessions: AgentSessionService,
    private readonly binding: StepSessionBindingService,
    private readonly execution: WorkflowStepExecutionService,
    private readonly museJobs: MuseExecutionJobService,
    private readonly deliveries: MuseDeliveryRequestService,
  ) {}

  async execute(input: {
    projectId: string;
    principalId: string;
    taskId: string;
    agentDefinitionId: string;
  }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    if (!input.agentDefinitionId?.trim())
      throw new DomainError("validation", "Choose the approved Muse agent before executing.");

    const task = await this.database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `orbit:tasks:${input.projectId}`,
      ]);
      const tasks = await transaction.query<TaskExecutionRow>(
        `SELECT * FROM project_tasks WHERE id=$1 AND project_id=$2 AND organization_id=$3 FOR UPDATE`,
        [input.taskId, input.projectId, actor.organizationId],
      );
      const current = tasks.rows[0];
      if (!current) throw new DomainError("not_found", "Task not found.");
      if (!["DRAFT", "NEEDS_INPUT", "FAILED"].includes(current.state))
        throw new DomainError("invalid_state", "This task is already running or finished.");
      const blockers = await transaction.query<{ title: string } & Record<string, unknown>>(
        `SELECT dependency.title FROM project_tasks dependency
         WHERE dependency.project_id=$1 AND dependency.organization_id=$2
           AND $3::jsonb ? dependency.task_key AND dependency.state <> 'DONE'
           AND NOT EXISTS (SELECT 1 FROM workflow_step_executions completed
             WHERE completed.id=dependency.step_id AND completed.project_id=dependency.project_id
               AND completed.organization_id=dependency.organization_id
               AND completed.state='COMPLETED')`,
        [input.projectId, actor.organizationId, JSON.stringify(current.dependency_keys)],
      );
      if (blockers.rows.length)
        throw new DomainError(
          "invalid_state",
          `Execute the dependent task first: ${blockers.rows.map((row) => row.title).join(", ")}.`,
        );

      await synchronizeWorkflowReviewContext(transaction, input.projectId, actor.organizationId);

      const plans = await transaction.query<
        { id: string; status: string; revision: number; content: unknown } & Record<string, unknown>
      >(
        `SELECT id,status,revision,content FROM plan_proposals WHERE id=$1 AND project_id=$2 AND organization_id=$3 FOR UPDATE`,
        [current.plan_id, input.projectId, actor.organizationId],
      );
      const plan = plans.rows[0];
      if (!plan)
        throw new DomainError("invalid_state", "The planning proposal for this task is gone.");
      if (plan.status === "READY_FOR_REVIEW") {
        await transaction.query(
          `UPDATE plan_proposals SET status='APPROVED',revision=revision+1,approved_by_principal_id=$3,updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='READY_FOR_REVIEW'`,
          [plan.id, actor.organizationId, input.principalId],
        );
        await transaction.query(
          `INSERT INTO approvals(id,organization_id,project_id,subject_type,subject_id,decision,decided_by_principal_id) VALUES($1,$2,$3,'plan',$4,'APPROVED',$5)`,
          [
            `approval_task_execute_${current.id}`,
            actor.organizationId,
            input.projectId,
            plan.id,
            input.principalId,
          ],
        );
        plan.status = "APPROVED";
        plan.revision += 1;
      } else if (plan.status !== "APPROVED") {
        throw new DomainError(
          "invalid_state",
          "Muse is still planning. Wait for the plan, then execute.",
        );
      }
      // Ensure context_versions.workflowReviews includes all approved evidence
      // before this task's snapshot is created, so missionWithWorkflowContext
      // can inject prior approved proposals like n8n chain data.
      await synchronizeWorkflowReviewContext(transaction, input.projectId, actor.organizationId);

      let graph = validateProposedWorkGraph(plan.content);
      let workItem = graph.workItems.find((item) => item.key === current.task_key);
      if (!workItem) {
        // Orbit: add-task tasks use task_key == id (e.g. task_1dfd...) and
        // do not exist in original plan's workItems. Also legacy tasks may
        // have key mismatch. Create on-the-fly work item, but don't fail the
        // whole execution on plan update conflicts — orbit resilience.
        if (current.task_key.startsWith("task_") || current.task_key.length > 32) {
          const safeTitle = current.title.slice(0, 200);
          const safeDesc = current.prompt.slice(0, 1200);
          const safeDeps = (current.dependency_keys as string[]).filter((dep) =>
            graph.workItems.some((it) => it.key === dep),
          );
          const newWorkItem = {
            key: current.task_key,
            title: safeTitle,
            description: safeDesc,
            dependsOn: safeDeps,
            workflows: [
              {
                name: "Implementation",
                steps: [{ title: safeTitle, executor: "agent", requiresApproval: false }],
              },
            ],
          };
          try {
            const contentObj = plan.content as Record<string, unknown> & {
              workItems: unknown[];
              summary: string;
              guardrails: unknown[];
              decisionsToReview: unknown[];
              assumptions: unknown[];
            };
            const updatedContent = {
              summary: contentObj.summary ?? "Updated with added task",
              workItems: [...contentObj.workItems, newWorkItem],
              guardrails: contentObj.guardrails ?? [],
              decisionsToReview: contentObj.decisionsToReview ?? [],
              assumptions: contentObj.assumptions ?? [],
            } as any;
            // Validate before persisting to avoid invalid_model_output
            const validatedGraph = validateProposedWorkGraph(updatedContent);
            await transaction.query(
              `UPDATE plan_proposals SET content=$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1`,
              [plan.id, JSON.stringify(validatedGraph)],
            );
            graph = validatedGraph;
            plan.content = validatedGraph as any;
            workItem = graph.workItems.find((item) => item.key === current.task_key)!;
          } catch (e) {
            // If validation or update fails, create a minimal in-memory graph
            // with just this work item, so execution can proceed even if plan
            // persisence fails — orbit execution must not be blocked.
            workItem = newWorkItem as any;
          }
        } else {
          throw new DomainError("invalid_state", "Task is no longer in the approved plan.");
        }
      }
      // One task = one Muse run: the first agent step carries the run.
      const agentStepIndexes: { workflowIndex: number; stepIndex: number }[] = [];
      if (!workItem) {
        throw new DomainError(
          "invalid_state",
          "Task has no executable workflow. Edit its prompt to add implementation details.",
        );
      }
      workItem.workflows.forEach((workflow, workflowIndex) =>
        workflow.steps.forEach((step, stepIndex) => {
          if (step.executor === "agent") agentStepIndexes.push({ workflowIndex, stepIndex });
        }),
      );
      const primary = agentStepIndexes[0];
      if (!primary)
        throw new DomainError(
          "invalid_state",
          "This task has no agent step for Muse to run. Edit the plan or add a coding task.",
        );
      await transaction.query(
        `UPDATE project_tasks SET state='STARTING',last_error=NULL,updated_at=now()
         WHERE id=$1 AND project_id=$2 AND organization_id=$3`,
        [current.id, input.projectId, actor.organizationId],
      );
      return { task: current, plan, primaryStep: primary };
    });

    let createdSessionId: string | undefined;
    try {
      if (task.task.state === "FAILED" && task.task.step_id) {
        const priorStep = await this.database.query<{ state: string } & Record<string, unknown>>(
          "SELECT state FROM workflow_step_executions WHERE id=$1 AND project_id=$2 AND organization_id=$3",
          [task.task.step_id, input.projectId, actor.organizationId],
        );
        if (priorStep.rows[0]?.state === "FAILED")
          await this.execution.authorizeRetry({
            projectId: input.projectId,
            principalId: input.principalId,
            stepId: task.task.step_id,
          });
      }
      // Materialize outside the task lock: the materializer takes its own
      // transaction and is idempotent-guarded by "already prepared".
      const existingSteps = await this.database.query<{ id: string } & Record<string, unknown>>(
        `SELECT id FROM workflow_step_executions WHERE project_id=$1 AND organization_id=$2 AND plan_id=$3 LIMIT 1`,
        [input.projectId, actor.organizationId, task.plan.id],
      );
      const primaryStepId = `step:${task.plan.id}:${task.task.task_key}:${task.primaryStep.workflowIndex}:${task.primaryStep.stepIndex}`;
      // Orbit: if plan already materialized (existingSteps exist) but this task
      // is a new work item (add-task id == task_key), ensure its step exists.
      if (!existingSteps.rows.length) {
        await this.materializer.materialize(input.projectId, input.principalId);
      } else {
        const stepExists = await this.database.query<{ id: string } & Record<string, unknown>>(
          `SELECT id FROM workflow_step_executions WHERE id=$1 AND project_id=$2 AND organization_id=$3 LIMIT 1`,
          [primaryStepId, input.projectId, actor.organizationId],
        );
        if (!stepExists.rows.length) {
          await this.database.query(
            `INSERT INTO orbit_work_items(id,organization_id,project_id,title) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [
              `work:${task.plan.id}:${task.task.task_key}`,
              actor.organizationId,
              input.projectId,
              task.task.title,
            ],
          );
          await this.database.query(
            `INSERT INTO workflow_step_executions(id,organization_id,project_id,plan_id,plan_revision,work_item_key,workflow_index,step_index,state,approval_required,task_id,task_prompt_revision,completion_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'BLOCKED',false,$9,$10,'github_ci') ON CONFLICT DO NOTHING`,
            [
              primaryStepId,
              actor.organizationId,
              input.projectId,
              task.plan.id,
              task.plan.revision,
              task.task.task_key,
              task.primaryStep.workflowIndex,
              task.primaryStep.stepIndex,
              task.task.id,
              task.task.revision,
            ],
          );
        }
      }

      await this.database.transaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `orbit:tasks:${input.projectId}`,
        ]);
        await transaction.query(
          `UPDATE workflow_step_executions SET state='CANCELED' WHERE project_id=$1 AND organization_id=$2 AND plan_id=$3 AND work_item_key=$4 AND id<>$5 AND state IN ('BLOCKED','READY')`,
          [input.projectId, actor.organizationId, task.plan.id, task.task.task_key, primaryStepId],
        );
        await transaction.query(
          `DELETE FROM workflow_step_prerequisites WHERE project_id=$1 AND organization_id=$2 AND step_id=$3`,
          [input.projectId, actor.organizationId, primaryStepId],
        );
        await transaction.query(
          `UPDATE workflow_step_executions SET approval_required=false,approved_by_principal_id=NULL,approved_at=NULL,completion_kind='github_ci',task_id=$4,task_prompt_revision=$5 WHERE id=$1 AND project_id=$2 AND organization_id=$3`,
          [primaryStepId, input.projectId, actor.organizationId, task.task.id, task.task.revision],
        );
        await transaction.query(
          `UPDATE project_tasks SET approved_revision=revision,approved_by_principal_id=$4,step_id=$5,github_authorized=true,automatic_repairs=0,last_error=NULL,updated_at=now() WHERE id=$1 AND project_id=$2 AND organization_id=$3`,
          [task.task.id, input.projectId, actor.organizationId, input.principalId, primaryStepId],
        );
      });

      const dependencyOutputs: Array<{ taskKey: string; title: string; output: string }> = [];
      if (task.task.dependency_keys.length > 0) {
        const outputs = await this.database.query<
          { task_key: string; title: string; content: string } & Record<string, unknown>
        >(
          `SELECT dep.task_key, dep.title, o.content FROM project_tasks dep LEFT JOIN workflow_step_executions step ON step.id=dep.step_id AND step.project_id=dep.project_id AND step.organization_id=dep.organization_id LEFT JOIN agent_sessions sess ON sess.id=COALESCE(dep.session_id, step.agent_session_id) AND sess.project_id=dep.project_id AND sess.organization_id=dep.organization_id LEFT JOIN muse_execution_jobs job ON job.agent_session_id=sess.id AND job.project_id=dep.project_id AND job.organization_id=dep.organization_id AND job.status='TURN_FINISHED' LEFT JOIN muse_job_outputs o ON o.job_id=job.id AND o.project_id=dep.project_id AND o.organization_id=dep.organization_id WHERE dep.project_id=$1 AND dep.organization_id=$2 AND $3::jsonb ? dep.task_key AND o.content IS NOT NULL ORDER BY o.created_at DESC`,
          [input.projectId, actor.organizationId, JSON.stringify(task.task.dependency_keys)],
        );
        const seenKeys = new Set<string>();
        for (const row of outputs.rows) {
          if (!seenKeys.has(row.task_key)) {
            seenKeys.add(row.task_key);
            dependencyOutputs.push({
              taskKey: row.task_key,
              title: row.title,
              output: row.content.slice(0, 4000),
            });
          }
        }
      }
      const internalStepsSuffix =
        "\n\nInternal execution instructions (always follow, do not create separate tasks):\n" +
        "- First, discover current implementation related to this task (read files, locate existing pattern, check whether feature exists). This is internal — do not produce a separate discovery output.\n" +
        "- Then implement the required change fully, in allowed paths only.\n" +
        "- Finally, verify locally (npm ci && npm run build if JS/TS project). Summarize clearly: What was implemented, Where, Verification result, and files changed. This summary becomes the PR description and completion message.\n" +
        "- Always finish with a concise execution summary under 12,000 characters. Do not paste entire source files. Explicitly report blockers or incomplete work.\n" +
        "- Format the final summary as concise Markdown with headings for What changed, Files changed, Verification, and Notes when needed. Use bullet lists and inline code for paths and identifiers. Include fenced code blocks with a language label for short, exact code changes or relevant commands when useful. Clearly label commands that were actually run versus suggested commands; never imply a check passed if it was not run.";
      const contextPrefix = dependencyOutputs.length
        ? `Previous tasks completed and their findings (use this context for your work):\n${dependencyOutputs
            .map((dep) => `--- ${dep.taskKey}: ${dep.title} ---\n${dep.output}`)
            .join("\n")}\n\n--- Current task ---\n`
        : "";
      const workItemId = `work:${task.plan.id}:${task.task.task_key}`;
      const fullMission = `${contextPrefix}${task.task.prompt}${internalStepsSuffix}`.slice(
        0,
        12000,
      );
      const created = await this.sessions.create({
        projectId: input.projectId,
        requestedBy: input.principalId,
        humanOwner: input.principalId,
        agentDefinitionId: input.agentDefinitionId,
        workItemId,
        mission: fullMission,
      });
      const sessionId = (created.session as { id: string }).id;
      createdSessionId = sessionId;
      await this.binding.bind({
        projectId: input.projectId,
        stepId: primaryStepId,
        sessionId,
        principalId: input.principalId,
      });
      await this.database.query(
        `UPDATE project_tasks SET session_id=$3,updated_at=now() WHERE id=$1 AND project_id=$2`,
        [task.task.id, input.projectId, sessionId],
      );
      await this.sessions.start(input.projectId, input.principalId, sessionId);
      const job = await this.museJobs.enqueue({
        projectId: input.projectId,
        sessionId,
        principalId: input.principalId,
        executeLocally: true,
      });
      await this.database.query(
        "UPDATE project_tasks SET state='ACTIVE',updated_at=now() WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND session_id=$4 AND state='STARTING'",
        [task.task.id, input.projectId, actor.organizationId, sessionId],
      );
      return {
        taskId: task.task.id,
        stepId: primaryStepId,
        sessionId,
        jobId: job.id as string,
        state: "ACTIVE",
      };
    } catch (failure) {
      if (createdSessionId) {
        await this.database.transaction(async (transaction) => {
          const retired = await transaction.query<{ id: string } & Record<string, unknown>>(
            `UPDATE agent_sessions session SET state='FAILED',ended_at=now()
             WHERE session.id=$1 AND session.project_id=$2 AND session.organization_id=$3
               AND session.state IN ('AUTHORIZED','RUNNING')
               AND NOT EXISTS(SELECT 1 FROM muse_execution_jobs job WHERE job.agent_session_id=session.id AND job.project_id=session.project_id AND job.organization_id=session.organization_id)
             RETURNING session.id`,
            [createdSessionId, input.projectId, actor.organizationId],
          );
          if (retired.rows.length)
            await transaction.query(
              "UPDATE workflow_step_executions SET state='FAILED' WHERE agent_session_id=$1 AND project_id=$2 AND organization_id=$3 AND state IN ('BLOCKED','READY','RUNNING')",
              [createdSessionId, input.projectId, actor.organizationId],
            );
        });
      }
      await this.database.query(
        `UPDATE project_tasks task SET state='FAILED',last_error='Execution could not start. Resolve the reported error and retry.',updated_at=now()
         WHERE task.id=$1 AND task.project_id=$2 AND task.organization_id=$3 AND task.state='STARTING'
           AND NOT EXISTS(SELECT 1 FROM muse_execution_jobs job WHERE job.agent_session_id=task.session_id
             AND job.project_id=task.project_id AND job.organization_id=task.organization_id AND job.status IN ('QUEUED','RUNNING'))`,
        [task.task.id, input.projectId, actor.organizationId],
      );
      throw failure;
    }
  }

  /**
   * Worker-side continuation after a Muse turn finishes: if the task
   * authorized GitHub delivery at Execute time, request the PR without
   * another human click. Output review is skipped only for task runs whose
   * prompt revision is the approved one.
   */
  async requestDeliveryIfAuthorized(input: { projectId: string; jobId: string }) {
    const rows = await this.database.query<
      { step_id: string; session_id: string; output_hash: string; principal_id: string } & Record<
        string,
        unknown
      >
    >(
      `SELECT task.step_id,task.session_id,output.content_hash AS output_hash,task.approved_by_principal_id AS principal_id
       FROM project_tasks task
       JOIN muse_job_outputs output ON output.job_id=$2 AND output.project_id=task.project_id AND output.organization_id=task.organization_id
       WHERE task.project_id=$1 AND task.github_authorized=true
         AND task.state='ACTIVE' AND task.session_id IS NOT NULL AND task.step_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM muse_execution_jobs job WHERE job.id=$2 AND job.agent_session_id=task.session_id AND job.workflow_step_id=task.step_id AND job.status='TURN_FINISHED' AND job.github_pull_number IS NULL)
       LIMIT 1`,
      [input.projectId, input.jobId],
    );
    const row = rows.rows[0];
    if (!row?.step_id || !row.principal_id) return false;
    await this.deliveries.request({
      projectId: input.projectId,
      stepId: row.step_id,
      principalId: row.principal_id,
      jobId: input.jobId,
      outputHash: row.output_hash,
    });
    return true;
  }
}
