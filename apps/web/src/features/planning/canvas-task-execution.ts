import type { ProjectTask } from "../intent/intent-api.js";

/** Mirrors the task execution boundary; the server rechecks authorization and prerequisites. */
export function canExecuteCanvasTask(task: ProjectTask): boolean {
  return (
    task.has_agent_executor === true &&
    ["DRAFT", "NEEDS_INPUT", "FAILED"].includes(task.state) &&
    ["DRAFT", "NEEDS_INPUT", "FAILED"].includes(task.display_state ?? task.state) &&
    (task.blocked_by?.length ?? 0) === 0
  );
}
