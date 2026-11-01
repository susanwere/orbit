import type { ExecutionStep, MuseJobStatus, ProjectIntentApi } from "./intent-api.js";

/** Refresh both sources: a finished Muse turn does not complete its workflow step. */
export async function loadExecutionStatus(
  api: Pick<ProjectIntentApi, "getExecutionSteps" | "getMuseJob">,
  projectId: string,
): Promise<{
  steps: readonly ExecutionStep[];
  jobs: Record<string, MuseJobStatus | null>;
  jobRefreshFailed: boolean;
}> {
  const steps = await api.getExecutionSteps(projectId);
  const sessionIds = [
    ...new Set(steps.flatMap((step) => (step.agent_session_id ? [step.agent_session_id] : []))),
  ];
  const jobResponses = await Promise.allSettled(
    sessionIds.map(async (sessionId) => ({
      sessionId,
      job: await api.getMuseJob(projectId, sessionId),
    })),
  );
  const jobs: Record<string, MuseJobStatus | null> = {};
  for (const response of jobResponses) {
    if (response.status === "fulfilled") jobs[response.value.sessionId] = response.value.job;
  }
  return {
    steps,
    jobs,
    jobRefreshFailed: jobResponses.some((response) => response.status === "rejected"),
  };
}

export function canReplaceQueuedSession(
  step: ExecutionStep,
  job: MuseJobStatus | null | undefined,
): boolean {
  return Boolean(
    step.agent_session_id &&
      step.state === "RUNNING" &&
      job?.status === "QUEUED" &&
      job.attempts === 0 &&
      job.needs_revision_replacement === true,
  );
}

export function canRequestDelivery(
  step: ExecutionStep,
  job: MuseJobStatus | null | undefined,
): boolean {
  return Boolean(
    step.state === "RUNNING" &&
      step.completion_kind === "github_ci" &&
      step.agent_session_id &&
      job?.workflow_step_id === step.id &&
      job.status === "TURN_FINISHED" &&
      job.output_hash &&
      job.output_source === "execution" &&
      job.changed_paths?.length &&
      !job.github_pull_number &&
      !job.delivery_state,
  );
}
