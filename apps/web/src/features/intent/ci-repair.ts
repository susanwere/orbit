import type { ExecutionStep, MuseJobStatus, ProjectIntentApi } from "./intent-api.js";

/** This boundary authorizes a fresh session only; it has no execution/dispatch capability. */
export async function authorizeFreshCiRepair(
  api: Pick<ProjectIntentApi, "inspectGithubCi" | "prepareCiRepair" | "authorizeExecutionRetry">,
  projectId: string,
  step: ExecutionStep,
  job: MuseJobStatus,
): Promise<void> {
  if (
    step.state !== "RUNNING" ||
    job.workflow_step_id !== step.id ||
    job.status !== "TURN_FINISHED"
  )
    throw new Error(
      "Refresh status. CI repair authorization requires this step's finished attempt.",
    );
  if (!job.needs_ci_repair_retry) await api.inspectGithubCi(projectId, step.id, job.id);
  await api.prepareCiRepair(projectId, step.id, job.id);
  await api.authorizeExecutionRetry(projectId, step.id);
}
