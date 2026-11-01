import type { ExecutionStep } from "../intent/intent-api.js";

/** Historical execution records remain on the server; a canvas only projects its approved revision. */
export function selectCurrentPlanSteps(
  steps: readonly ExecutionStep[],
  planId: string | null,
  revision: number,
): ExecutionStep[] {
  if (!planId) return [];
  return steps.filter((step) => step.plan_id === planId && step.plan_revision === revision);
}

/** Display-only summary. It never changes step state, authorization, or execution eligibility. */
export function overallWorkflowStatus(
  steps: readonly Pick<ExecutionStep, "state">[],
): string | undefined {
  if (!steps.length) return undefined;
  if (steps.every((step) => step.state === "COMPLETED")) return "COMPLETED";
  const states = new Set(steps.map((step) => step.state));
  // Active execution wins; otherwise surface failure before waiting or remaining work.
  return ["RUNNING", "FAILED", "WAITING", "READY", "BLOCKED", "CANCELED"].find((state) =>
    states.has(state),
  );
}
