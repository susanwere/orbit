import { describe, expect, it } from "vitest";
import type { ExecutionStep, MuseJobStatus } from "../intent/intent-api.js";
import {
  isReadyForReview,
  executionDisplayState,
  canvasExecutionPollDelay,
  selectCurrentPlanSteps,
  overallWorkflowStatus,
} from "./work-item-status.js";

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
    [["COMPLETED", "CANCELED"], "COMPLETED"],
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

describe("review handoff", () => {
  const waitingStep = { ...currentStep, state: "WAITING", blocker_reason: "pull_request_review" };
  it("projects review readiness without mutating the persisted waiting state", () => {
    expect(isReadyForReview(waitingStep)).toBe(true);
    expect(executionDisplayState(waitingStep)).toBe("READY_FOR_REVIEW");
    expect(overallWorkflowStatus([waitingStep, { state: "CANCELED" }])).toBe("READY_FOR_REVIEW");
    expect(waitingStep.state).toBe("WAITING");
    expect(isReadyForReview({ ...waitingStep, state: "COMPLETED" })).toBe(false);
  });
  it("uses slower merge observation after CI and stops polling completed executions", () => {
    expect(canvasExecutionPollDelay([currentStep], [], {}, false)).toBe(2000);
    expect(canvasExecutionPollDelay([waitingStep], [], {}, false)).toBe(15000);
    expect(
      canvasExecutionPollDelay([{ ...waitingStep, state: "COMPLETED" }], [], {}, false),
    ).toBeNull();
    expect(canvasExecutionPollDelay([waitingStep], [], {}, true)).toBe(2000);
  });
});

it("stops showing active execution and polling after delivery fails", () => {
  const job: MuseJobStatus = {
    id: "job",
    status: "TURN_FINISHED",
    workflow_step_id: "current-step",
    delivery_state: "ERROR",
    attempts: 1,
    started_at: null,
    finished_at: null,
    failure_reason: null,
    github_repository: null,
    github_pull_number: null,
  };
  expect(executionDisplayState(currentStep, job)).toBe("FAILED");
  expect(canvasExecutionPollDelay([currentStep], [], { "current-session": job }, false)).toBeNull();
  expect(executionDisplayState({ ...currentStep, state: "COMPLETED" }, job)).toBe("COMPLETED");
});

it("stops polling a stale running step when its agent finished without changes or delivery", () => {
  const job: MuseJobStatus = {
    id: "job",
    status: "TURN_FINISHED",
    workflow_step_id: currentStep.id,
    attempts: 1,
    started_at: null,
    finished_at: null,
    failure_reason: null,
    changed_paths: [],
    github_repository: null,
    github_pull_number: null,
  };
  expect(executionDisplayState(currentStep, job)).toBe("NEEDS_INPUT");
  expect(overallWorkflowStatus([currentStep], { "current-session": job })).toBe("NEEDS_INPUT");
  expect(canvasExecutionPollDelay([currentStep], [], { "current-session": job }, false)).toBeNull();
  expect(
    canvasExecutionPollDelay(
      [currentStep],
      [],
      { "current-session": { ...job, delivery_state: "RUNNING" } },
      false,
    ),
  ).toBe(2000);
  expect(executionDisplayState({ ...currentStep, state: "COMPLETED" }, job)).toBe("COMPLETED");
});
