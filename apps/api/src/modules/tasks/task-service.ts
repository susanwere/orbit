import { randomUUID } from "node:crypto";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import { validateProposedWorkGraph } from "../planning/muse-work-graph-planner.js";
import { synchronizeWorkflowReviewContext } from "../context/workflow-review-context.js";
import type { TaskDrafter } from "./task-drafter.js";

export interface TaskRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  project_id: string;
  plan_id: string;
  task_key: string;
  title: string;
  prompt: string;
  revision: number;
  approved_revision: number | null;
  state: string;
  dependency_keys: string[];
  step_id: string | null;
  session_id: string | null;
  source_job_id: string | null;
  github_authorized: boolean;
  automatic_repairs: number;
  approved_by_principal_id: string | null;
}
export class TaskService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
    private readonly drafter?: TaskDrafter,
  ) {}
  async initialize(projectId: string, principalId: string) {
    const actor = await this.authorization.authorize(principalId, projectId, "review");
    await this.database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `orbit:tasks:${projectId}`,
      ]);
      const plans = await transaction.query<
        { id: string; content: unknown } & Record<string, unknown>
      >(
        "SELECT id,content FROM plan_proposals WHERE project_id=$1 AND organization_id=$2 AND status IN ('APPROVED','READY_FOR_REVIEW')",
        [projectId, actor.organizationId],
      );
      const plan = plans.rows[0];
      if (!plan) return;
      const allItems = validateProposedWorkGraph(plan.content).workItems;
      // Orbit rule: skip pure discovery/verification/roposal buckets — they
      // are internal to engineering tasks. Filter heuristically for backward
      // compat with plans created before SYSTEM_PROMPT update.
      const engineeringOnly = (item: (typeof allItems)[number]) => {
        const combined = (item.title + " " + item.description).toLowerCase();
        const isDiscovery =
          combined.startsWith("discover") ||
          combined.startsWith("locate") ||
          combined.includes("discover current") ||
          combined.includes("locate the");
        const isVerification =
          combined.includes("suggest verification") ||
          (combined.startsWith("validate ") && combined.includes("behavior")) ||
          combined.includes("define how to check") ||
          combined.includes("plan verification") ||
          combined.includes("suggest verification checks");
        const isProposalOnly =
          (combined.includes("propose") || combined.includes("draft candidate")) &&
          !combined.includes("implement");
        return !isDiscovery && !isVerification && !isProposalOnly;
      };
      const filteredItems = allItems.filter(engineeringOnly);
      const effectiveItems = filteredItems.length > 0 ? filteredItems : allItems;
      for (const item of effectiveItems) {
        const steps = await transaction.query<
          { id: string; state: string; agent_session_id: string | null } & Record<string, unknown>
        >(
          "SELECT id,state,agent_session_id FROM workflow_step_executions WHERE project_id=$1 AND organization_id=$2 AND plan_id=$3 AND work_item_key=$4",
          [projectId, actor.organizationId, plan.id, item.key],
        );
        const delivered = await transaction.query<
          { id: string; workflow_step_id: string } & Record<string, unknown>
        >(
          "SELECT job.id,job.workflow_step_id FROM muse_execution_jobs job JOIN workflow_step_executions step ON step.id=job.workflow_step_id AND step.project_id=job.project_id AND step.organization_id=job.organization_id WHERE job.project_id=$1 AND job.organization_id=$2 AND step.plan_id=$3 AND step.work_item_key=$4 AND job.github_repository IS NOT NULL ORDER BY job.created_at DESC LIMIT 1",
          [projectId, actor.organizationId, plan.id, item.key],
        );
        const complete =
          steps.rows.length > 0 && steps.rows.every((step) => step.state === "COMPLETED");
        await transaction.query(
          `INSERT INTO project_tasks(id,organization_id,project_id,plan_id,task_key,title,prompt,dependency_keys,state,step_id,source_job_id,created_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) ON CONFLICT(project_id,task_key) DO NOTHING`,
          [
            `task_${randomUUID()}`,
            actor.organizationId,
            projectId,
            plan.id,
            item.key,
            item.title.slice(0, 200),
            item.description.slice(0, 4000),
            JSON.stringify(item.dependsOn),
            complete ? "DONE" : "DRAFT",
            delivered.rows[0]?.workflow_step_id ?? null,
            delivered.rows[0]?.id ?? null,
            principalId,
          ],
        );
      }
    });
    return this.list(projectId, principalId);
  }
  async list(projectId: string, principalId: string) {
    const actor = await this.authorization.authorize(principalId, projectId, "read");
    const tasks = await this.database.query<TaskRow>(
      `SELECT task.*,job.id AS job_id,job.status AS job_status,job.local_execution_state,job.failure_reason,output.content AS response,output.changed_paths,job.github_repository,job.github_pull_number,job.github_head_sha,job.github_ci_state,job.github_ci_report,job.github_review_state,job.delivery_state,job.delivery_error,
         CASE WHEN step.state='COMPLETED' THEN 'DONE' WHEN task.state='DRAFT' THEN 'DRAFT' WHEN job.github_review_state='READY' THEN 'IN_REVIEW' WHEN job.github_ci_state='FAILED' THEN 'ACTIVE' WHEN job.status='TURN_FINISHED' AND output.changed_paths='[]'::jsonb THEN 'NEEDS_INPUT' WHEN job.status='FAILED' THEN 'FAILED' ELSE task.state END AS display_state,
         (SELECT jsonb_agg(dep.title) FROM project_tasks dep WHERE dep.project_id=task.project_id AND dep.organization_id=task.organization_id AND task.dependency_keys ? dep.task_key AND dep.state <> 'DONE' AND NOT EXISTS (SELECT 1 FROM workflow_step_executions c WHERE c.id=dep.step_id AND c.project_id=dep.project_id AND c.state='COMPLETED')) AS blocked_by,
         CASE WHEN plan.content->'workItems' IS NOT NULL THEN (
           SELECT EXISTS(
             SELECT 1 FROM jsonb_array_elements(plan.content->'workItems') AS item,
               jsonb_array_elements(item->'workflows') AS wf,
               jsonb_array_elements(wf->'steps') AS st
             WHERE item->>'key'=task.task_key AND st->>'executor'='human'
           )
         ) ELSE false END AS has_human_executor,
         CASE WHEN plan.content->'workItems' IS NOT NULL THEN (
           SELECT EXISTS(
             SELECT 1 FROM jsonb_array_elements(plan.content->'workItems') AS item,
               jsonb_array_elements(item->'workflows') AS wf,
               jsonb_array_elements(wf->'steps') AS st
             WHERE item->>'key'=task.task_key AND st->>'executor'='agent'
           )
         ) ELSE false END AS has_agent_executor
    FROM project_tasks task
    JOIN plan_proposals plan ON plan.id=task.plan_id
    LEFT JOIN workflow_step_executions step ON step.id=task.step_id AND step.project_id=task.project_id AND step.organization_id=task.organization_id
    LEFT JOIN agent_sessions session ON session.id=COALESCE(task.session_id,step.agent_session_id) AND session.project_id=task.project_id AND session.organization_id=task.organization_id
    LEFT JOIN muse_execution_jobs job ON job.agent_session_id=session.id AND job.project_id=task.project_id AND job.organization_id=task.organization_id
    LEFT JOIN muse_job_outputs output ON output.job_id=job.id AND output.project_id=task.project_id AND output.organization_id=task.organization_id
    WHERE task.project_id=$1 AND task.organization_id=$2 ORDER BY task.created_at,task.id`,
      [projectId, actor.organizationId],
    );
    return tasks.rows;
  }
  async update(input: {
    projectId: string;
    principalId: string;
    taskId: string;
    revision: number;
    title: string;
    prompt: string;
  }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    if (
      typeof input.prompt !== "string" ||
      !input.prompt.trim() ||
      input.prompt.length > 4000 ||
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 200 ||
      !Number.isSafeInteger(input.revision)
    )
      throw new DomainError(
        "validation",
        "Provide a task title and prompt (up to 4000 characters).",
      );
    // Allow edit in ACTIVE when CI failed (user wants to fix CI) or NEEDS_INPUT, DRAFT, FAILED
    // Do not block ACTIVE edits when job is TURN_FINISHED (finished run, waiting for CI/repair or needs input)
    const changed = await this.database.query<TaskRow>(
      `UPDATE project_tasks task SET title=$5,prompt=$6,revision=revision+1,updated_at=now(),last_error=NULL WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND revision=$4 AND state IN ('DRAFT','NEEDS_INPUT','FAILED','ACTIVE') AND NOT EXISTS(SELECT 1 FROM muse_execution_jobs job WHERE job.workflow_step_id=task.step_id AND job.project_id=task.project_id AND job.status IN ('QUEUED','RUNNING')) RETURNING *`,
      [
        input.taskId,
        input.projectId,
        actor.organizationId,
        input.revision,
        input.title.trim(),
        input.prompt.trim(),
      ],
    );
    if (!changed.rows[0])
      throw new DomainError(
        "stale_context_version",
        "Task changed or is running. Refresh before editing; active snapshots stay unchanged.",
      );
    return changed.rows[0];
  }

  async approveProposal(input: {
    projectId: string;
    principalId: string;
    taskId: string;
    note?: string;
  }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    if (actor.role !== "admin" && actor.role !== "member")
      throw new DomainError("forbidden", "Only members can approve proposals.");
    if (input.note !== undefined && typeof input.note !== "string")
      throw new DomainError("validation", "Approval note must be text.");
    return this.database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `orbit:tasks:${input.projectId}`,
      ]);
      const tasks = await tx.query<
        TaskRow & {
          session_id: string | null;
          plan_revision: number | null;
          output_job: string | null;
          output_hash: string | null;
        } & Record<string, unknown>
      >(
        `SELECT task.*,step.agent_session_id AS step_session,step.plan_revision,
           output.job_id AS output_job,output.content_hash AS output_hash
         FROM project_tasks task
         LEFT JOIN workflow_step_executions step ON step.id=task.step_id AND step.project_id=task.project_id AND step.organization_id=task.organization_id
         LEFT JOIN agent_sessions sess ON sess.id=COALESCE(task.session_id,step.agent_session_id) AND sess.project_id=task.project_id AND sess.organization_id=task.organization_id
         LEFT JOIN muse_execution_jobs job ON job.agent_session_id=sess.id AND job.project_id=task.project_id AND job.organization_id=task.organization_id AND job.status='TURN_FINISHED'
         LEFT JOIN muse_job_outputs output ON output.job_id=job.id AND output.project_id=task.project_id AND output.organization_id=task.organization_id
         WHERE task.id=$1 AND task.project_id=$2 AND task.organization_id=$3 FOR UPDATE OF task`,
        [input.taskId, input.projectId, actor.organizationId],
      );
      const task = tasks.rows[0];
      if (!task) throw new DomainError("not_found", "Task not found.");
      if (task!.state === "DONE")
        throw new DomainError("invalid_state", "This task is already done.");
      if (task!.state === "ACTIVE") {
        const activeJobs = await tx.query<{ id: string } & Record<string, unknown>>(
          `SELECT job.id FROM project_tasks t LEFT JOIN workflow_step_executions step ON step.id=t.step_id AND step.project_id=t.project_id LEFT JOIN agent_sessions s ON s.id=COALESCE(t.session_id,step.agent_session_id) LEFT JOIN muse_execution_jobs job ON job.agent_session_id=s.id AND job.project_id=t.project_id AND job.status IN ('QUEUED','RUNNING') WHERE t.id=$1 AND t.project_id=$2 LIMIT 1`,
          [input.taskId, input.projectId],
        );
        if (activeJobs.rows.length)
          throw new DomainError("invalid_state", "Task is running — wait for it to finish.");
      }
      const trim = input.note?.trim() ?? "";
      if (task.step_id) {
        await tx.query(
          `UPDATE workflow_step_executions SET state='COMPLETED',completed_at=now(),approved_by_principal_id=$3,approved_at=now() WHERE id=$1 AND project_id=$2 AND state IN ('RUNNING','BLOCKED','READY')`,
          [task.step_id, input.projectId, input.principalId],
        );
        // Insert evidence so synchronizeWorkflowReviewContext publishes this
        // approval into context_versions.content.workflowReviews, making next
        // task's context_snapshot mission include approved proposal content.
        const planRev = (task as any).plan_revision ?? 1;
        const outputJob = (task as any).output_job ?? null;
        const outputHash = (task as any).output_hash ?? null;
        await tx.query(
          `INSERT INTO evidence(id,organization_id,project_id,scope_type,scope_id,category,result,title,summary,produced_by_principal_id,agent_session_id,metadata)
           VALUES($1,$2,$3,'workflow_step',$4,'human_review','PASSED','Human approval of proposal task',$5,$6,$7,$8::jsonb)
           ON CONFLICT DO NOTHING`,
          [
            `evidence_${randomUUID()}`,
            actor.organizationId,
            input.projectId,
            task.step_id,
            trim.slice(0, 2000) || "Approved via task proposal approval.",
            input.principalId,
            (task as any).session_id ?? (task as any).step_session ?? null,
            JSON.stringify({
              jobId: outputJob,
              outputHash,
              planRevision: String(planRev),
              decision: "approved",
              taskKey: task.task_key,
            }),
          ],
        );
      }
      // Publish into context_versions.content.workflowReviews so next snapshot's
      // missionWithWorkflowContext includes this approval, like n8n node chaining.
      await synchronizeWorkflowReviewContext(tx, input.projectId, actor.organizationId);
      const approved = await tx.query<TaskRow>(
        `UPDATE project_tasks SET state='DONE',last_error=NULL,updated_at=now() WHERE id=$1 AND project_id=$2 RETURNING *`,
        [input.taskId, input.projectId],
      );
      return approved.rows[0];
    });
  }
  async add(input: { projectId: string; principalId: string; request: string }) {
    const actor = await this.authorization.authorize(input.principalId, input.projectId, "review");
    if (typeof input.request !== "string" || !input.request.trim() || input.request.length > 4000)
      throw new DomainError("validation", "Describe the new task in up to 4000 characters.");
    const tasks = await this.list(input.projectId, input.principalId);
    const context = await this.database.transaction(async (transaction) => {
      try {
        await synchronizeWorkflowReviewContext(transaction, input.projectId, actor.organizationId);
      } catch {
        // Best-effort context sync — don't block task creation
      }
      return transaction.query<
        { statement: string; content: unknown; plan_id: string } & Record<string, unknown>
      >(
        `SELECT intent.statement,version.content,plan.id AS plan_id FROM intents intent JOIN plan_proposals plan ON plan.project_id=intent.project_id AND plan.organization_id=intent.organization_id JOIN project_context_heads head ON head.project_id=intent.project_id AND head.organization_id=intent.organization_id JOIN context_versions version ON version.id=head.current_context_version_id WHERE intent.project_id=$1 AND intent.organization_id=$2`,
        [input.projectId, actor.organizationId],
      );
    });
    const current = context.rows[0];
    if (!current)
      throw new DomainError(
        "invalid_state",
        "Describe the project intent and let Muse plan it first.",
      );

    // Orbit fallback: try Muse Spark drafting, but on model outage create
    // task directly from user request — orbit model ensures task chain works
    // even when Meta Model API returns 404/5xx, like n8n offline resilience.
    let title = input.request.trim().slice(0, 200);
    let prompt = input.request.trim().slice(0, 4000);
    let dependencyKeys: string[] = [];
    let existingTaskId: string | null = null;

    // Orbit model: Add task = new work item among what Muse originally created.
    // First, try to enrich via Muse Spark (dedup + dependency suggestion),
    // but never block creation on model errors — new work item always added.
    if (this.drafter) {
      try {
        const draft = await this.drafter.draft({
          request: input.request.trim(),
          originalIntent: current.statement,
          projectContext: current.content,
          tasks,
        });
        if (draft.existingTaskId) return { existingTaskId: draft.existingTaskId, task: null };
        title = draft.title;
        prompt = draft.prompt;
        // Validate dependencyKeys against current tasks only, not spark output
        // that may reference stale keys from pruned discovery/verification
        dependencyKeys = (draft.dependencyKeys as string[]).filter((key) =>
          tasks.some((t) => t.task_key === key),
        );
      } catch (error) {
        // On any drafting error (404, invalid response, unknown tasks), still
        // create a new work item from user request — orbit-wise, add task is
        // always a new work item alongside originals, never blocked by model.
        if (
          !(
            error instanceof DomainError &&
            (error.code === "model_api_error" || error.code === "invalid_model_response")
          )
        ) {
          // For non-model errors (validation, etc), rethrow
          throw error;
        }
      }
    }

    const id = `task_${randomUUID()}`;
    const created = await this.database.query<TaskRow>(
      `INSERT INTO project_tasks(id,organization_id,project_id,plan_id,task_key,title,prompt,request_prompt,dependency_keys,created_by_principal_id) VALUES($1,$2,$3,$4,$1,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
      [
        id,
        actor.organizationId,
        input.projectId,
        current.plan_id,
        title,
        prompt,
        input.request.trim(),
        JSON.stringify(dependencyKeys),
        input.principalId,
      ],
    );
    return { existingTaskId: existingTaskId, task: created.rows[0] };
  }
}
