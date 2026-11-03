import { canExecuteCanvasTask } from "./canvas-task-execution.js";
import { executionDisplayState } from "./work-item-status.js";
import type { MuseJobStatus, ExecutionStep, ProjectTask } from "../intent/intent-api.js";

/** Use the work item's bound run; legacy canceled internal steps are not separate UI work. */
export function selectWorkItemExecution(
  workItemKey: string,
  executionSteps: readonly ExecutionStep[],
  task?: ProjectTask,
): ExecutionStep | undefined {
  const matchingSteps = executionSteps.filter((step) => step.work_item_key === workItemKey);
  return (
    (task?.session_id
      ? matchingSteps.find((step) => step.agent_session_id === task.session_id)
      : undefined) ??
    matchingSteps.find((step) => step.agent_session_id && step.state !== "CANCELED") ??
    matchingSteps.find((step) => step.state !== "CANCELED") ??
    matchingSteps[0]
  );
}

export function workItemExecutionStatus(
  approved: boolean,
  task?: ProjectTask,
  executionStep?: ExecutionStep,
  job?: MuseJobStatus | null,
): string {
  const executionStatus = executionDisplayState(executionStep, job);
  if (executionStep && !["READY", "BLOCKED"].includes(executionStep.state))
    return executionStatus ?? executionStep.state;
  if (approved && task && canExecuteCanvasTask(task)) return "READY";
  return executionStatus ?? (approved ? "Awaiting execution" : "Proposed");
}
