import { describe, expect, it } from "vitest";
import type { ExecutionStep, ProjectTask } from "../intent/intent-api.js";
import { selectWorkItemExecution, workItemExecutionStatus } from "./work-item-execution.js";
const current: ExecutionStep = {
  id: "current",
  work_item_key: "build",
  workflow_index: 0,
  step_index: 0,
  state: "RUNNING",
  blocker_reason: null,
  approval_required: false,
  approved_at: null,
  agent_session_id: "current-session",
};
const task: ProjectTask = {
  id: "task",
  task_key: "build",
  title: "Build",
  prompt: "Build",
  revision: 1,
  state: "ACTIVE",
  session_id: "current-session",
  has_agent_executor: true,
};
describe("work item detail projection", () => {
  it("uses the current bound execution instead of canceled internal steps or older attempts", () => {
    const legacySteps = [
      { ...current, id: "canceled", state: "CANCELED", step_index: 1, agent_session_id: null },
      { ...current, id: "old", agent_session_id: "old-session", state: "COMPLETED" },
      current,
    ];
    expect(selectWorkItemExecution("build", legacySteps, task)).toEqual(current);
  });
  it("selects an actual run before legacy placeholders when no task binding is available", () => {
    expect(
      selectWorkItemExecution("build", [
        { ...current, state: "CANCELED", agent_session_id: null },
        current,
      ]),
    ).toEqual(current);
    expect(selectWorkItemExecution("another-item", [current], task)).toBeUndefined();
  });
  it("shows a ready work item even when its internal execution record awaits session setup", () => {
    expect(
      workItemExecutionStatus(
        true,
        { ...task, state: "DRAFT" },
        { ...current, state: "BLOCKED", blocker_reason: "agent_session_required" },
      ),
    ).toBe("READY");
    expect(workItemExecutionStatus(false, { ...task, state: "DRAFT" })).toBe("Proposed");
    expect(workItemExecutionStatus(true, task, current)).toBe("RUNNING");
    expect(
      workItemExecutionStatus(true, { ...task, state: "DONE" }, { ...current, state: "COMPLETED" }),
    ).toBe("COMPLETED");
  });
});
