import { useCallback, useEffect, useState } from "react";
import type { ExecutionStep, MuseJobStatus, ProjectIntentApi } from "../intent/intent-api.js";
import { selectCurrentPlanSteps } from "./work-item-status.js";
import { loadExecutionStatus } from "../intent/execution-status.js";

/** Read-only status projection. Opening or refreshing the canvas never queues execution. */
export function useCanvasExecution(
  api: ProjectIntentApi,
  projectId: string,
  enabled: boolean,
  planId: string | null,
  planRevision: number,
) {
  const [executionSteps, setExecutionSteps] = useState<readonly ExecutionStep[]>([]);
  const [museJobs, setMuseJobs] = useState<Record<string, MuseJobStatus | null>>({});
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const refreshExecution = useCallback(() => setRefreshAttempt((attempt) => attempt + 1), []);
  useEffect(() => {
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
        const status = await loadExecutionStatus(
          {
            getExecutionSteps: async (id) =>
              selectCurrentPlanSteps(await api.getExecutionSteps(id), planId, planRevision),
            getMuseJob: (id, sessionId) => api.getMuseJob(id, sessionId),
          },
          projectId,
        );
        if (!active) return;
        setExecutionSteps(status.steps);
        setMuseJobs(status.jobs);
        setExecutionError(
          status.jobRefreshFailed
            ? "Some agent statuses could not refresh. Refresh execution status to retry."
            : null,
        );
        if (status.steps.some((step) => step.state === "RUNNING") || status.jobRefreshFailed)
          timer = setTimeout(() => {
            void refresh();
          }, 2000);
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
  return { executionSteps, museJobs, executionError, refreshExecution };
}
