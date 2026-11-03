import { describe, expect, it } from "vitest";
import { describeTaskActivity, type EnrichedProjectTask } from "./task-activity.js";
import type { MuseJobStatus } from "./intent-api.js";

function job(partial: Partial<MuseJobStatus>): MuseJobStatus {
  return {
    id: "job-1",
    status: "QUEUED",
    workflow_step_id: "step-1",
    attempts: 0,
    started_at: null,
    finished_at: null,
    failure_reason: null,
    github_repository: "susanwere/private-test",
    github_pull_number: null,
    ...partial,
  };
}
function task(partial: Partial<EnrichedProjectTask>): EnrichedProjectTask {
  return {
    id: "task-1",
    task_key: "a",
    title: "Task",
    prompt: "Do it",
    revision: 1,
    state: "DRAFT",
    displayState: "DRAFT",
    blockedBy: [],
    job: null,
    ...partial,
  };
}

describe("friendly task activity", () => {
  it("explains queued, running and preparing states instead of looking stuck", () => {
    expect(
      describeTaskActivity(
        task({ job: job({ status: "QUEUED", local_execution_state: "REQUESTED" }) }),
      ).headline,
    ).toContain("Waiting for the local Muse worker");
    expect(
      describeTaskActivity(
        task({ job: job({ status: "QUEUED", local_execution_state: "PREPARING" }) }),
      ).headline,
    ).toContain("Preparing a clean checkout");
    expect(
      describeTaskActivity(
        task({ job: job({ status: "RUNNING", local_execution_state: "RUNNING" }) }),
      ).headline,
    ).toContain("Muse is writing the code");
  });

  it("describes the PR and CI repair loop until green", () => {
    const failed = describeTaskActivity(
      task({
        displayState: "ACTIVE",
        automatic_repairs: 1,
        job: job({
          status: "TURN_FINISHED",
          github_pull_number: 11,
          github_ci_state: "FAILED",
          github_ci_report: {
            summary: "CI FAILED",
            runs: [
              {
                id: 1,
                name: "CI",
                conclusion: "failure",
                url: "https://example.test",
                failures: [],
              },
            ],
          },
        }),
      }),
    );
    expect(failed.headline).toContain("repairing it automatically");
    expect(failed.detail).toContain("Failing check: CI");
    const green = describeTaskActivity(
      task({
        displayState: "IN_REVIEW",
        job: job({ status: "TURN_FINISHED", github_pull_number: 11, github_ci_state: "PASSED" }),
      }),
    );
    expect(green.headline).toContain("CI is green");
    expect(green.isWorking).toBe(false);
  });

  it("handles waiting dependencies and finished-without-changes", () => {
    expect(describeTaskActivity(task({ blockedBy: ["Setup"] })).headline).toContain(
      "Waiting for Setup",
    );
    const noChanges = describeTaskActivity(
      task({
        displayState: "NEEDS_INPUT",
        job: job({ status: "TURN_FINISHED", changed_paths: [] }),
      }),
    );
    expect(noChanges.headline).toContain("made no code changes");
  });
});

it("reports a merged task as finished instead of continuing to request review", () => {
  const activity = describeTaskActivity(
    task({
      state: "DONE",
      displayState: "DONE",
      job: job({ status: "TURN_FINISHED", github_pull_number: 11, github_ci_state: "PASSED" }),
    }),
  );
  expect(activity.headline).toBe("Pull request merged and verified");
  expect(activity.isWorking).toBe(false);
});
