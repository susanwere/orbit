import type { MuseJobStatus, ProjectTask, ExecutionStep } from "../intent/intent-api.js";

/** Historical execution records remain on the server; a canvas only projects its approved revision. */
export function selectCurrentPlanSteps(
  steps: readonly ExecutionStep[],
  planId: string | null,
  revision: number,
): ExecutionStep[] {
  if (!planId) return [];
  return steps.filter((step) => step.plan_id === planId && step.plan_revision === revision);
}

type ExecutionState = Pick<ExecutionStep, "state"> &
  Partial<Pick<ExecutionStep, "blocker_reason" | "agent_session_id">>;

export function isReadyForReview(step?: ExecutionState, job?: MuseJobStatus | null): boolean {
  return Boolean(
    step &&
      ["RUNNING", "WAITING"].includes(step.state) &&
      (step.blocker_reason === "pull_request_review" ||
        (job?.status === "TURN_FINISHED" &&
          job.github_ci_state === "PASSED" &&
          job.github_pull_number)),
  );
}

export function executionDisplayState(
  step?: ExecutionState,
  job?: MuseJobStatus | null,
): string | undefined {
  if (step && ["RUNNING", "WAITING"].includes(step.state)) {
    if (
      job?.status === "FAILED" ||
      job?.local_execution_state === "ERROR" ||
      job?.delivery_state === "ERROR"
    )
      return "FAILED";
    if (
      job?.status === "TURN_FINISHED" &&
      job.changed_paths?.length === 0 &&
      !job.github_pull_number &&
      !["REQUESTED", "RUNNING"].includes(job.delivery_state ?? "")
    )
      return "NEEDS_INPUT";
  }
  return isReadyForReview(step, job) ? "READY_FOR_REVIEW" : step?.state;
}

/** Display-only summary; canceled internal steps do not undo the current completed run. */
export function overallWorkflowStatus(
  steps: readonly ExecutionState[],
  jobs: Readonly<Record<string, MuseJobStatus | null>> = {},
): string | undefined {
  if (!steps.length) return undefined;
  const relevantSteps = steps.filter((step) => step.state !== "CANCELED");
  if (!relevantSteps.length) return "CANCELED";
  if (relevantSteps.every((step) => step.state === "COMPLETED")) return "COMPLETED";
  const states = new Set(
    relevantSteps.map((step) =>
      executionDisplayState(step, step.agent_session_id ? jobs[step.agent_session_id] : null),
    ),
  );
  return [
    "RUNNING",
    "FAILED",
    "NEEDS_INPUT",
    "READY_FOR_REVIEW",
    "WAITING",
    "READY",
    "BLOCKED",
  ].find((state) => states.has(state));
}

/** Observe review/merge quietly; do not keep an execution spinner or rapid polling after CI passes. */
export function canvasExecutionPollDelay(
  steps: readonly ExecutionStep[],
  tasks: readonly ProjectTask[],
  jobs: Readonly<Record<string, MuseJobStatus | null>>,
  refreshFailed: boolean,
): number | null {
  if (
    refreshFailed ||
    steps.some(
      (step) =>
        step.state === "RUNNING" &&
        !["FAILED", "NEEDS_INPUT"].includes(
          executionDisplayState(step, step.agent_session_id ? jobs[step.agent_session_id] : null) ??
            "",
        ) &&
        !isReadyForReview(step, step.agent_session_id ? jobs[step.agent_session_id] : null),
    ) ||
    tasks.some(
      (task) =>
        task.delivery_state !== "ERROR" &&
        ["STARTING", "ACTIVE"].includes(task.display_state ?? task.state),
    )
  )
    return 2000;
  if (
    steps.some((step) =>
      isReadyForReview(step, step.agent_session_id ? jobs[step.agent_session_id] : null),
    ) ||
    tasks.some((task) => (task.display_state ?? task.state) === "IN_REVIEW")
  )
    return 15000;
  return null;
}
