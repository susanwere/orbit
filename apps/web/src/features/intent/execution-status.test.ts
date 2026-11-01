import { describe, expect, it, vi } from "vitest";
import {
  loadExecutionStatus,
  canReplaceQueuedSession,
  canRequestDelivery,
} from "./execution-status.js";
import type { ExecutionStep, MuseJobStatus } from "./intent-api.js";

const step: ExecutionStep = {
  id: "step",
  state: "RUNNING",
  blocker_reason: "running",
  work_item_key: "greeting",
  workflow_index: 0,
  step_index: 0,
  approval_required: false,
  approved_at: null,
  agent_session_id: "session",
};
const job: MuseJobStatus = {
  id: "job",
  status: "TURN_FINISHED",
  workflow_step_id: "step",
  attempts: 1,
  started_at: null,
  finished_at: "2026-11-01T00:00:00Z",
  failure_reason: null,
  github_repository: null,
  github_pull_number: null,
};
describe("execution status refresh", () => {
  it("refreshes the persisted Muse outcome while preserving an incomplete step", async () => {
    const getMuseJob = vi
      .fn()
      .mockResolvedValueOnce({ ...job, status: "QUEUED" })
      .mockResolvedValueOnce(job);
    const api = { getExecutionSteps: vi.fn().mockResolvedValue([step]), getMuseJob };
    expect((await loadExecutionStatus(api, "project")).jobs.session?.status).toBe("QUEUED");
    const refreshed = await loadExecutionStatus(api, "project");
    expect(refreshed.jobs.session?.status).toBe("TURN_FINISHED");
    expect(refreshed.steps[0]?.state).toBe("RUNNING");
    expect(getMuseJob).toHaveBeenLastCalledWith("project", "session");
    expect(refreshed.jobRefreshFailed).toBe(false);
  });
  it("preserves steps and successful job reads and reports partial failures without stale jobs", async () => {
    const refreshed = await loadExecutionStatus(
      {
        getExecutionSteps: async () => [step, { ...step, id: "second", agent_session_id: "other" }],
        getMuseJob: async (_projectId, sessionId) => {
          if (sessionId === "other") throw new Error("unavailable");
          return job;
        },
      },
      "project",
    );
    expect(refreshed.steps).toHaveLength(2);
    expect(refreshed.jobs).toEqual({ session: job });
    expect(refreshed.jobRefreshFailed).toBe(true);
  });
  it("only queries bound sessions once, and distinguishes a missing job from a failed read", async () => {
    const getMuseJob = vi.fn().mockResolvedValue(null);
    const refreshed = await loadExecutionStatus(
      {
        getExecutionSteps: async () => [step, step, { ...step, agent_session_id: null }],
        getMuseJob,
      },
      "project",
    );
    expect(getMuseJob).toHaveBeenCalledTimes(1);
    expect(refreshed.jobs).toEqual({ session: null });
    expect(refreshed.jobRefreshFailed).toBe(false);
  });
});

describe("queued-session replacement loop regression", () => {
  it("offers replacement only for stale feedback and hides it for the corrected queued job", () => {
    const stale = { ...job, status: "QUEUED", attempts: 0, needs_revision_replacement: true };
    expect(canReplaceQueuedSession(step, stale)).toBe(true);
    const corrected = { ...stale, id: "replacement-job", needs_revision_replacement: false };
    expect(canReplaceQueuedSession(step, corrected)).toBe(false);
    expect(canReplaceQueuedSession(step, { ...job, status: "QUEUED", attempts: 0 })).toBe(false);
    expect(canReplaceQueuedSession(step, { ...stale, status: "RUNNING" })).toBe(false);
    expect(canReplaceQueuedSession(step, { ...stale, attempts: 1 })).toBe(false);
    expect(canReplaceQueuedSession({ ...step, agent_session_id: null }, stale)).toBe(false);
  });
});

describe("explicit PR delivery eligibility", () => {
  it("requires a code turn with changed files and hides duplicate or failed delivery actions", () => {
    const codeStep: ExecutionStep = { ...step, completion_kind: "github_ci" };
    const codeJob = {
      ...job,
      output_hash: "a".repeat(64),
      output_source: "execution",
      changed_paths: ["src/App.tsx"],
    };
    expect(canRequestDelivery(codeStep, codeJob)).toBe(true);
    expect(canRequestDelivery(codeStep, { ...codeJob, workflow_step_id: "other-step" })).toBe(
      false,
    );
    for (const delivery_state of ["REQUESTED", "RUNNING", "FINISHED", "ERROR"] as const)
      expect(canRequestDelivery(codeStep, { ...codeJob, delivery_state })).toBe(false);
    expect(canRequestDelivery({ ...codeStep, completion_kind: "human_review" }, codeJob)).toBe(
      false,
    );
    expect(canRequestDelivery(codeStep, { ...codeJob, changed_paths: [] })).toBe(false);
    expect(canRequestDelivery(codeStep, { ...codeJob, output_source: "read_only_recovery" })).toBe(
      false,
    );
    expect(canRequestDelivery(codeStep, { ...codeJob, github_pull_number: 123 })).toBe(false);
    expect(canRequestDelivery(codeStep, { ...codeJob, status: "RUNNING" })).toBe(false);
  });
});
