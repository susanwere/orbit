import { describe, expect, it } from "vitest";
import type { ExecutionStep } from "../intent/intent-api.js";
import { selectCurrentPlanSteps, overallWorkflowStatus } from "./work-item-status.js";

const currentStep: ExecutionStep = {
  id: "current-step",
  plan_id: "current-plan",
  plan_revision: 3,
  work_item_key: "jobs-api-pagination",
  workflow_index: 0,
  step_index: 0,
  state: "RUNNING",
  blocker_reason: null,
  approval_required: false,
  approved_at: null,
  agent_session_id: "current-session",
};

describe("current plan execution projection", () => {
  it("excludes canceled steps from older plans and revisions without altering authoritative states", () => {
    const steps = [
      { ...currentStep, id: "old-plan-step", plan_id: "old-plan", state: "CANCELED" },
      { ...currentStep, id: "old-revision-step", plan_revision: 2, state: "CANCELED" },
      currentStep,
    ];
    expect(selectCurrentPlanSteps(steps, "current-plan", 3)).toEqual([currentStep]);
    expect(steps[0]!.state).toBe("CANCELED");
    expect(steps[1]!.state).toBe("CANCELED");
  });
  it("does not associate unscoped records or an unknown plan with the current workflow", () => {
    expect(
      selectCurrentPlanSteps(
        [{ ...currentStep, plan_id: undefined, plan_revision: undefined }],
        "current-plan",
        3,
      ),
    ).toEqual([]);
    expect(selectCurrentPlanSteps([currentStep], null, 3)).toEqual([]);
  });
});

describe("overall workflow status", () => {
  it.each([
    [["RUNNING", "CANCELED"], "RUNNING"],
    [["COMPLETED", "RUNNING"], "RUNNING"],
    [["RUNNING", "FAILED"], "RUNNING"],
    [["FAILED", "BLOCKED"], "FAILED"],
    [["WAITING", "READY"], "WAITING"],
    [["READY", "BLOCKED"], "READY"],
    [["COMPLETED", "BLOCKED"], "BLOCKED"],
    [["COMPLETED", "CANCELED"], "CANCELED"],
    [["CANCELED", "CANCELED"], "CANCELED"],
    [["COMPLETED", "COMPLETED"], "COMPLETED"],
  ] as const)("summarizes current steps %j as %s", (states, expected) => {
    const steps = states.map((state) => ({ state }));
    expect(overallWorkflowStatus(steps)).toBe(expected);
    expect(overallWorkflowStatus([...steps].reverse())).toBe(expected);
    expect(steps.map((step) => step.state)).toEqual(states);
  });
  it("does not claim completion for no evidence or an unrecognized state", () => {
    expect(overallWorkflowStatus([])).toBeUndefined();
    expect(overallWorkflowStatus([{ state: "UNKNOWN" }, { state: "COMPLETED" }])).toBeUndefined();
  });
});
