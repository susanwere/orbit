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
 * until CI is green. It never merges and never widens permissions; it stops
 * only at human gates, missing input, or a check that cannot be inspected.
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
  ) {}

  /** Returns a short action label for logging, or null when there is nothing to advance. */
  async advanceNext(projectId: string): Promise<string | null> {
    const candidates = await this.database.query<AutomatedTaskRow>(
      `SELECT task.id,task.plan_id,task.task_key,task.prompt,task.step_id,task.session_id,
              task.approved_by_principal_id,task.automatic_repairs,
              job.id AS job_id,job.status AS job_status,job.github_ci_state,job.github_pull_number,job.delivery_state
       FROM project_tasks task
       JOIN muse_execution_jobs job ON job.agent_session_id=task.session_id
         AND job.project_id=task.project_id AND job.organization_id=task.organization_id
       WHERE task.project_id=$1 AND task.github_authorized=true AND task.state='ACTIVE'
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
            `UPDATE project_tasks SET last_error=$3,updated_at=now() WHERE id=$1 AND project_id=$2`,
            [task.id, projectId, error.message.slice(0, 500)],
          );
          return `blocked:${task.id}`;
        }
        throw error;
      }
    }
    return null;
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
      await this.database.query(
        `UPDATE project_tasks SET state='IN_REVIEW',last_error=NULL,updated_at=now() WHERE id=$1 AND project_id=$2 AND state='ACTIVE'`,
        [task.id, projectId],
      );
      return `ci-passed:${task.id}`;
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
        `UPDATE project_tasks SET last_error=$3,updated_at=now() WHERE id=$1 AND project_id=$2 AND state='ACTIVE'`,
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
      `UPDATE project_tasks SET session_id=$3,automatic_repairs=automatic_repairs+1,source_job_id=$4,last_error=NULL,updated_at=now() WHERE id=$1 AND project_id=$2`,
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
