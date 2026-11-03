import { GithubCiEvidenceService } from "../execution/github-ci-evidence-service.js";
import type { GithubCiReport } from "../execution/github-ci-monitor.js";
import { DomainError } from "@orbit/domain";
import type { SqlDatabase } from "@orbit/db";
import type { ProjectAuthorizationService } from "../projects/project-authorization.js";
import { GithubCiMonitor } from "../execution/github-ci-monitor.js";
import { MuseCiRepairService } from "../execution/muse-ci-repair-service.js";
import { WorkflowStepExecutionService } from "../execution/workflow-step-execution-service.js";
import { AgentSessionService } from "../agents/agent-session-service.js";
import { StepSessionBindingService } from "../execution/step-session-binding-service.js";
import { MuseExecutionJobService } from "../execution/muse-execution-worker.js";

interface AutomatedTaskRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  plan_id: string;
  task_key: string;
  prompt: string;
  step_id: string;
  session_id: string;
  approved_by_principal_id: string;
  automatic_repairs: number;
  job_id: string;
  job_status: string;
  github_ci_state: string | null;
  github_pull_number: number | null;
  delivery_state: string | null;
}

/**
 * Continues a task that a human already authorized with Execute: waits for
 * CI, and on a verified failure keeps starting fresh Muse repair sessions
 * until CI is green, then observes the human merge and verifies completion.
 * It never merges or widens permissions; execution pauses for review after CI.
 */
export class TaskAutomationService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly authorization: ProjectAuthorizationService,
    private readonly ciMonitor: GithubCiMonitor,
    private readonly ciRepairs: MuseCiRepairService,
    private readonly execution: WorkflowStepExecutionService,
    private readonly sessions: AgentSessionService,
    private readonly binding: StepSessionBindingService,
    private readonly museJobs: MuseExecutionJobService,
    private readonly githubEvidence: GithubCiEvidenceService,
  ) {}

  /** Returns a short action label for logging, or null when there is nothing to advance. */
  async advanceNext(projectId: string): Promise<string | null> {
    const candidates = await this.database.query<AutomatedTaskRow>(
      `SELECT task.id,task.organization_id,task.plan_id,task.task_key,task.prompt,task.step_id,task.session_id,
              task.approved_by_principal_id,task.automatic_repairs,
              job.id AS job_id,job.status AS job_status,job.github_ci_state,job.github_pull_number,job.delivery_state
       FROM project_tasks task
       JOIN muse_execution_jobs job ON job.agent_session_id=task.session_id
         AND job.project_id=task.project_id AND job.organization_id=task.organization_id
       JOIN workflow_step_executions step ON step.id=task.step_id
         AND step.project_id=task.project_id AND step.organization_id=task.organization_id
         AND step.agent_session_id=task.session_id AND job.workflow_step_id=step.id
       WHERE task.project_id=$1 AND task.github_authorized=true AND task.state IN ('ACTIVE','IN_REVIEW')
         AND step.state IN ('RUNNING','WAITING')
         AND task.step_id IS NOT NULL AND task.session_id IS NOT NULL
       ORDER BY job.created_at DESC LIMIT 20`,
      [projectId],
    );
    for (const task of candidates.rows) {
      try {
        const action = await this.advanceTask(projectId, task);
        if (action) return action;
      } catch (error) {
        if (error instanceof DomainError) {
          await this.database.query(
            `UPDATE project_tasks SET last_error=$4,updated_at=now() WHERE id=$1 AND project_id=$2 AND organization_id=$3 AND state IN ('ACTIVE','IN_REVIEW')`,
            [task.id, projectId, task.organization_id, error.message.slice(0, 500)],
          );
          return `blocked:${task.id}`;
        }
        throw error;
      }
    }
    return null;
  }

  private async markAwaitingReview(
    projectId: string,
    task: AutomatedTaskRow,
    report: GithubCiReport,
  ): Promise<boolean> {
    const actor = await this.authorization.authorize(
      task.approved_by_principal_id,
      projectId,
      "review",
    );
    if (actor.organizationId !== task.organization_id)
      throw new DomainError("forbidden", "Task belongs to another organization.");
    return this.database.transaction(async (transaction) => {
      const eligible = await transaction.query<{ state: string } & Record<string, unknown>>(
        `SELECT step.state FROM workflow_step_executions step
         JOIN agent_sessions session ON session.id=step.agent_session_id AND session.project_id=step.project_id AND session.organization_id=step.organization_id
         JOIN muse_execution_jobs job ON job.agent_session_id=session.id AND job.project_id=step.project_id AND job.organization_id=step.organization_id AND job.workflow_step_id=step.id
         JOIN plan_proposals plan ON plan.id=step.plan_id AND plan.project_id=step.project_id AND plan.organization_id=step.organization_id
         JOIN project_tasks task ON task.id=$4 AND task.project_id=step.project_id AND task.organization_id=step.organization_id AND task.step_id=step.id AND task.session_id=session.id
         WHERE step.id=$1 AND step.project_id=$2 AND step.organization_id=$3 AND job.id=$5
           AND step.state IN ('RUNNING','WAITING') AND session.state IN ('RUNNING','WAITING')
           AND plan.status='APPROVED' AND plan.revision=step.plan_revision
           AND job.status='TURN_FINISHED' AND job.github_ci_state='PASSED' AND job.github_head_sha=$6
           AND task.state IN ('ACTIVE','IN_REVIEW') AND task.github_authorized=true
           AND NOT EXISTS (SELECT 1 FROM human_gates gate WHERE gate.project_id=step.project_id AND gate.organization_id=step.organization_id AND gate.agent_session_id=session.id AND gate.status='OPEN')
         FOR UPDATE OF step,session,job,task`,
        [task.step_id, projectId, actor.organizationId, task.id, task.job_id, report.headSha],
      );
      const step = eligible.rows[0];
      if (!step)
        throw new DomainError(
          "invalid_state",
          "Execution changed before review readiness could be recorded.",
        );
      await transaction.query(
        "UPDATE workflow_step_executions SET state='WAITING' WHERE id=$1 AND project_id=$2 AND organization_id=$3",
        [task.step_id, projectId, actor.organizationId],
      );
      await transaction.query(
        "UPDATE agent_sessions SET state='WAITING' WHERE id=$1 AND project_id=$2 AND organization_id=$3",
        [task.session_id, projectId, actor.organizationId],
      );
      await transaction.query(
        "UPDATE project_tasks SET state='IN_REVIEW',last_error=NULL,updated_at=now() WHERE id=$1 AND project_id=$2 AND organization_id=$3",
        [task.id, projectId, actor.organizationId],
      );
      if (step.state === "RUNNING") {
        await transaction.query(
          `INSERT INTO muse_execution_activity(job_id,organization_id,project_id,stage,status,message)
          VALUES($1,$2,$3,'output','completed','CI passed. The pull request is ready for your review and merge.')`,
          [task.job_id, actor.organizationId, projectId],
        );
      }
      return step.state === "RUNNING";
    });
  }

  private async advanceTask(projectId: string, task: AutomatedTaskRow): Promise<string | null> {
    const principalId = task.approved_by_principal_id;
    if (task.job_status === "TURN_FINISHED" && !task.github_pull_number) {
      // No PR and (per the delivery guard) no changed paths: Muse finished
      // without edits, e.g. it diagnosed a problem it is not permitted to
      // fix. Retrying the identical repair would loop forever, so surface it.
      const outputs = await this.database.query<{ content: string } & Record<string, unknown>>(
        `SELECT output.content FROM muse_job_outputs output
         WHERE output.job_id=$1 AND output.project_id=$2
           AND output.changed_paths='[]'::jsonb LIMIT 1`,
        [task.job_id, projectId],
      );
      if (outputs.rows[0]) {
        const diagnosis = outputs.rows[0].content.replace(/\s+/g, " ").trim().slice(0, 480);
        await this.database.query(
          `UPDATE project_tasks SET state='NEEDS_INPUT',last_error=$3,updated_at=now() WHERE id=$1 AND project_id=$2 AND state='ACTIVE'`,
          [
            task.id,
            projectId,
            `Muse finished without changing code, so no new PR or CI run can happen. Its diagnosis: ${diagnosis} Review it, edit the task prompt if needed, then Execute again.`,
          ],
        );
        return `needs-input:${task.id}`;
      }
      return null;
    }
    if (task.job_status !== "TURN_FINISHED" || !task.github_pull_number) return null;

    const report = await this.ciMonitor.inspect({
      jobId: task.job_id,
      projectId,
    });
    if (report.state === "WAITING" || report.state === "PENDING") return null;
    if (report.state === "PASSED") {
      if (report.mergedAt) {
        const ciRun = report.runs.find((run) => run.name === "CI" && run.conclusion === "success");
        if (!ciRun)
          throw new DomainError(
            "invalid_state",
            "No passing CI run is available for merge verification.",
          );
        await this.githubEvidence.verify({
          projectId,
          principalId,
          stepId: task.step_id,
          repository: report.repository,
          pullNumber: report.pullNumber,
          runId: ciRun.id,
        });
        return `pr-merged:${task.id}`;
      }
      const changed = await this.markAwaitingReview(projectId, task, report);
      return changed ? `ci-passed:${task.id}` : null;
    }
    if (report.state === "FAILED") {
      // Store CI failure summary as last_error so UI can show what failed,
      // but keep state ACTIVE so auto-repair can continue OR user can
      // intervene: edit prompt and Execute again, or create follow-up task.
      const failedRuns =
        report.runs?.filter((r) => r.conclusion && r.conclusion !== "success") ?? [];
      const failureHint = failedRuns.length
        ? failedRuns.map((r) => `${r.name}: ${r.failures.join(", ")}`).join("; ")
        : report.summary.slice(0, 400);
      await this.database.query(
        `UPDATE project_tasks SET state='ACTIVE',last_error=$3,updated_at=now() WHERE id=$1 AND project_id=$2 AND state IN ('ACTIVE','IN_REVIEW')`,
        [
          task.id,
          projectId,
          `CI failed: ${failureHint} (run #${report.runs?.[0]?.id ?? ""}). Muse will retry, or you can edit the prompt and Execute to fix it, or create a follow-up task.`,
        ],
      );
      // Still proceed with auto-repair — user intervention is optional,
      // not blocking. The task remains ACTIVE with CI state FAILED.
    }

    // Verified CI failure: keep repairing until CI is green. The count is
    // progress visibility only; nothing is abandoned at an arbitrary cap.
    const prepared = await this.ciRepairs.prepare({
      projectId,
      stepId: task.step_id,
      principalId,
      jobId: task.job_id,
    });
    await this.execution.authorizeRetry({ projectId, principalId, stepId: task.step_id });
    const agents = await this.sessions.listApproved(projectId, principalId);
    const museAgent = agents.find((agent) => agent.provider.toLowerCase() === "meta") ?? agents[0];
    if (!museAgent)
      throw new DomainError(
        "invalid_state",
        "No approved Muse agent is available for the CI repair.",
      );
    const created = await this.sessions.create({
      projectId,
      requestedBy: principalId,
      humanOwner: principalId,
      agentDefinitionId: museAgent.id,
      workItemId: `work:${task.plan_id}:${task.task_key}`,
      mission: task.prompt.slice(0, 2000),
      repairSourceJobId: prepared.repairSourceJobId,
    });
    const repairSessionId = (created.session as { id: string }).id;
    await this.binding.bind({
      projectId,
      stepId: task.step_id,
      sessionId: repairSessionId,
      principalId,
    });
    await this.database.query(
      `UPDATE project_tasks SET state='ACTIVE',session_id=$3,automatic_repairs=automatic_repairs+1,source_job_id=$4,last_error=NULL,updated_at=now() WHERE id=$1 AND project_id=$2`,
      [task.id, projectId, repairSessionId, prepared.repairSourceJobId],
    );
    await this.sessions.start(projectId, principalId, repairSessionId);
    await this.museJobs.enqueue({
      projectId,
      sessionId: repairSessionId,
      principalId,
      executeLocally: true,
    });
    return `ci-repair-started:${task.id}`;
  }
}
