import { describe, expect, it, vi } from "vitest";
import type { ExecutionStep, MuseJobStatus } from "./intent-api.js";
import { authorizeFreshCiRepair } from "./ci-repair.js";

const step: ExecutionStep = {
  id: "step",
  state: "RUNNING",
  agent_session_id: "finished-session",
  blocker_reason: "running",
  work_item_key: "greeting",
  workflow_index: 1,
  step_index: 0,
  approval_required: false,
  approved_at: null,
};
const job: MuseJobStatus = {
  id: "finished-job",
  workflow_step_id: "step",
  status: "TURN_FINISHED",
  attempts: 1,
  started_at: "2026-11-01T01:00:00Z",
  finished_at: "2026-11-01T01:01:00Z",
  failure_reason: null,
  github_repository: null,
  github_pull_number: null,
  needs_ci_repair_retry: true,
  repair_source_job_id: "original-delivered-job",
};
function fixture() {
  return {
    inspectGithubCi: vi.fn().mockResolvedValue(undefined),
    prepareCiRepair: vi.fn().mockResolvedValue(undefined),
    authorizeExecutionRetry: vi.fn().mockResolvedValue(undefined),
    createAgentSession: vi.fn(),
    bindExecutionSession: vi.fn(),
    startAgentSession: vi.fn(),
    dispatchMuse: vi.fn(),
  };
}

describe("fresh CI repair authorization never executes an attempt", () => {
  it("retires the exact no-change attempt without replaying or creating any job/session", async () => {
    const api = fixture();
    const preservedJob = { ...job };
    await authorizeFreshCiRepair(api, "project", step, job);
    expect(api.inspectGithubCi).not.toHaveBeenCalled();
    expect(api.prepareCiRepair).toHaveBeenCalledWith("project", "step", "finished-job");
    expect(api.authorizeExecutionRetry).toHaveBeenCalledWith("project", "step");
    expect(api.createAgentSession).not.toHaveBeenCalled();
    expect(api.bindExecutionSession).not.toHaveBeenCalled();
    expect(api.startAgentSession).not.toHaveBeenCalled();
    expect(api.dispatchMuse).not.toHaveBeenCalled();
    expect(job).toEqual(preservedJob);
  });
  it("rechecks a delivered failure before authorizing repair", async () => {
    const api = fixture();
    await authorizeFreshCiRepair(api, "project", step, { ...job, needs_ci_repair_retry: false });
    expect(api.inspectGithubCi).toHaveBeenCalledWith("project", "step", "finished-job");
    expect(api.inspectGithubCi.mock.invocationCallOrder[0]).toBeLessThan(
      api.prepareCiRepair.mock.invocationCallOrder[0]!,
    );
    expect(api.dispatchMuse).not.toHaveBeenCalled();
  });
  it("refuses another step's job or an already-running attempt", async () => {
    for (const invalidJob of [
      { ...job, workflow_step_id: "other-step" },
      { ...job, status: "RUNNING" },
    ]) {
      const api = fixture();
      await expect(authorizeFreshCiRepair(api, "project", step, invalidJob)).rejects.toThrow(
        "finished attempt",
      );
      expect(api.prepareCiRepair).not.toHaveBeenCalled();
      expect(api.dispatchMuse).not.toHaveBeenCalled();
    }
  });
  it("stops if failure inspection fails and does not authorize a retry", async () => {
    const api = fixture();
    api.inspectGithubCi.mockRejectedValue(new Error("CI changed"));
    await expect(
      authorizeFreshCiRepair(api, "project", step, { ...job, needs_ci_repair_retry: false }),
    ).rejects.toThrow("CI changed");
    expect(api.prepareCiRepair).not.toHaveBeenCalled();
    expect(api.authorizeExecutionRetry).not.toHaveBeenCalled();
  });
});
