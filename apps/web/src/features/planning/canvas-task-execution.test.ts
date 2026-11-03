import { describe, expect, it } from "vitest";
import { canExecuteCanvasTask } from "./canvas-task-execution.js";
import type { ProjectTask } from "../intent/intent-api.js";

const readyTask: ProjectTask = {
  id: "task-1",
  task_key: "build",
  title: "Build",
  prompt: "Build it",
  revision: 1,
  state: "DRAFT",
  display_state: "DRAFT",
  blocked_by: [],
  has_agent_executor: true,
};
describe("canvas task eligibility", () => {
  it.each(["DRAFT", "FAILED", "NEEDS_INPUT"] as const)(
    "allows an unblocked %s coding task",
    (state) => {
      expect(canExecuteCanvasTask({ ...readyTask, state, display_state: state })).toBe(true);
    },
  );
  it("rejects blocked, non-agent, active and completed tasks", () => {
    expect(canExecuteCanvasTask({ ...readyTask, blocked_by: ["Prerequisite"] })).toBe(false);
    expect(canExecuteCanvasTask({ ...readyTask, has_agent_executor: false })).toBe(false);
    expect(canExecuteCanvasTask({ ...readyTask, has_agent_executor: undefined })).toBe(false);
    expect(canExecuteCanvasTask({ ...readyTask, display_state: "DONE" })).toBe(false);
    expect(canExecuteCanvasTask({ ...readyTask, state: "ACTIVE", display_state: "FAILED" })).toBe(
      false,
    );
  });
});
