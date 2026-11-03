import { useCallback, useEffect, useState } from "react";
import type {
  ExecutionStep,
  MuseJobStatus,
  ProjectIntentApi,
  ProjectTask,
} from "../intent/intent-api.js";
import { canvasExecutionPollDelay, selectCurrentPlanSteps } from "./work-item-status.js";
import { loadExecutionStatus } from "../intent/execution-status.js";

/** Read-only status projection. Opening or refreshing the canvas never queues execution. */
export function useCanvasExecution(
  api: ProjectIntentApi,
  projectId: string,
  enabled: boolean,
  planId: string | null,
  planRevision: number,
) {
  const [tasks, setTasks] = useState<readonly ProjectTask[]>([]);
  const [executionSteps, setExecutionSteps] = useState<readonly ExecutionStep[]>([]);
  const [museJobs, setMuseJobs] = useState<Record<string, MuseJobStatus | null>>({});
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const refreshExecution = useCallback(() => setRefreshAttempt((attempt) => attempt + 1), []);
  useEffect(() => {
    setTasks([]);
    setExecutionSteps([]);
    setMuseJobs({});
    setExecutionError(null);
  }, [projectId, enabled, planId, planRevision]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setExecutionError(null);
    if (!enabled) return;
    const refresh = async () => {
      try {
        const [status, currentTasks] = await Promise.all([
          loadExecutionStatus(
            {
              getExecutionSteps: async (id) =>
                selectCurrentPlanSteps(await api.getExecutionSteps(id), planId, planRevision),
              getMuseJob: (id, sessionId) => api.getMuseJob(id, sessionId),
            },
            projectId,
          ),
          api.getTasks(projectId),
        ]);
        if (!active) return;
        setTasks(currentTasks);
        setExecutionSteps(status.steps);
        setMuseJobs(status.jobs);
        setExecutionError(
          status.jobRefreshFailed
            ? "Some agent statuses could not refresh. Refresh execution status to retry."
            : null,
        );
        const pollDelay = canvasExecutionPollDelay(
          status.steps,
          currentTasks,
          status.jobs,
          status.jobRefreshFailed,
        );
        if (pollDelay !== null)
          timer = setTimeout(() => {
            void refresh();
          }, pollDelay);
      } catch {
        if (active)
          setExecutionError(
            "Could not refresh execution status. The saved plan is still available.",
          );
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, projectId, enabled, planId, planRevision, refreshAttempt]);
  return { tasks, executionSteps, museJobs, executionError, refreshExecution };
}
